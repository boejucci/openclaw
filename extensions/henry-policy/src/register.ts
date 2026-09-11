import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { Pool as PgPool } from "pg";
import { resolveHenryPolicyConfig } from "./config.js";
import { createHenryDb } from "./db.js";
import { createDecisionLogger } from "./logger.js";
import { createPolicyHook } from "./policy-hook.js";
import { buildSafeServerNameMap } from "./safe-names.js";

export type HenryPolicyDeps = {
  resolveSecret?: (params: { config: unknown; value: unknown; path: string }) => Promise<string>;
  now?: () => number;
  // Injected in tests to avoid importing real pg; the real Pool constructor is used by default.
  Pool?: typeof PgPool;
};

// Module-scope singleton registry: DSN string → Pool instance.
//
// The gateway loader can invoke register() more than once per process (duplicate
// discovery roots observed live — same pattern as henry-sf's PROCESS_RUN_TOKEN_SECRET).
// If we created a new Pool on every register() call, two identical configurations
// would open duplicate connection pools to the same database, wasting connections
// and giving each pool an independent lifecycle.  Keying by resolved DSN means two
// register() calls with the same database share one pool; a different DSN gets its
// own.  The gateway_stop handler guards against double-close by deleting the entry
// from the registry before calling pool.end().
const poolsByDsn = new Map<string, PgPool>();

function createJwtDsnResolver(
  api: OpenClawPluginApi,
  resolveSecret: HenryPolicyDeps["resolveSecret"],
): (dsn: unknown) => Promise<string> {
  return async (dsn) => {
    const path = "plugins.entries.henry-policy.config.db.dsn";
    if (resolveSecret) {
      return resolveSecret({ config: api.config, value: dsn, path });
    }
    const resolved = await resolveConfiguredSecretInputString({
      config: api.config,
      env: process.env,
      value: dsn,
      path,
    });
    if (resolved.value === undefined) {
      throw new Error(
        `henry-policy: db.dsn did not resolve: ${resolved.unresolvedRefReason ?? "unknown reason"}`,
      );
    }
    return resolved.value;
  };
}

export function registerHenryPolicy(api: OpenClawPluginApi, deps: HenryPolicyDeps = {}): void {
  const config = resolveHenryPolicyConfig({ pluginConfig: api.pluginConfig });
  const resolveDsn = createJwtDsnResolver(api, deps.resolveSecret);
  const PoolCtor: typeof PgPool | undefined = deps.Pool;

  // Lazy pool: resolved on the first before_tool_call invocation so that a missing
  // Postgres at Gateway startup does not crash the Gateway load.
  //
  // Recovery behavior: if DSN resolution fails, poolResolvePromise is reset to
  // undefined so the next call retries — but only after a minimum 30-second gap
  // (lastFailureTime tracks when resolution last failed). Within the 30-second
  // window, the gate fails closed immediately without re-attempting. This prevents
  // a tight retry loop while still allowing automatic recovery after a transient
  // DSN outage without requiring a Gateway restart.
  let poolResolvePromise: Promise<PgPool> | undefined;
  let lastFailureTime: number | undefined;
  const RETRY_DELAY_MS = 30_000;

  function now(): number {
    return deps.now ? deps.now() : Date.now();
  }

  function getOrCreatePool(): Promise<PgPool> {
    if (poolResolvePromise !== undefined) {
      return poolResolvePromise;
    }

    // Within the retry window after a failure: fail closed immediately.
    if (lastFailureTime !== undefined && now() - lastFailureTime < RETRY_DELAY_MS) {
      return Promise.reject(new Error("henry-policy: DSN resolution failed; retrying after 30s"));
    }

    poolResolvePromise = resolveDsn(config.db.dsn).then((dsn) => {
      const existing = poolsByDsn.get(dsn);
      if (existing !== undefined) {
        return existing;
      }

      // Require the real pg Pool at runtime; PoolCtor is only injected in tests.
      const PgPoolCtor: typeof PgPool = PoolCtor ?? (require("pg").Pool as typeof PgPool);
      const pool = new PgPoolCtor({ connectionString: dsn, max: config.db.poolMax });
      poolsByDsn.set(dsn, pool);
      return pool;
    });

    // On failure: reset so a future call can retry after the delay window.
    poolResolvePromise = poolResolvePromise.catch((err: unknown) => {
      lastFailureTime = now();
      poolResolvePromise = undefined;
      throw err;
    });

    return poolResolvePromise;
  }

  const mcpServerNameMap = buildSafeServerNameMap(
    Object.keys((api.config as { mcp?: { servers?: Record<string, unknown> } }).mcp?.servers ?? {}),
  );

  // The db and logger wrappers are created eagerly (they have no side effects),
  // but they only call getOrCreatePool() when the first tool call arrives.
  let dbInstance: ReturnType<typeof createHenryDb> | undefined;
  let loggerInstance: ReturnType<typeof createDecisionLogger> | undefined;

  // Proxy objects that lazily initialise db/logger on first use so both can
  // be constructed before the pool is available.
  const db: ReturnType<typeof createHenryDb> = {
    async getPerson(profileId) {
      if (dbInstance === undefined) {
        const pool = await getOrCreatePool();
        dbInstance = createHenryDb({
          pool,
          cacheTtlMs: config.cacheTtlSeconds * 1000,
          now: deps.now,
        });
      }
      return dbInstance.getPerson(profileId);
    },
    // db.close() is a test convenience path; gateway_stop owns pool lifecycle directly.
    async close() {
      return dbInstance?.close() ?? Promise.resolve();
    },
  };

  const logger: ReturnType<typeof createDecisionLogger> = {
    log(entry) {
      if (loggerInstance === undefined) {
        // Logger is constructed synchronously — fire-and-forget writes happen
        // after pool resolution, but log() itself never awaits.
        void getOrCreatePool()
          .then((pool) => {
            loggerInstance = createDecisionLogger({ pool });
            loggerInstance.log(entry);
          })
          .catch(() => console.warn("[henry-policy] pool unavailable; decision log entry dropped"));
        return;
      }
      loggerInstance.log(entry);
    },
  };

  const handler = createPolicyHook({
    db,
    logger,
    globalDefaultVerdict: config.defaultVerdict,
    passthroughNoPrincipal: config.passthroughNoPrincipal,
    mcpServerNameMap,
  });

  api.on("before_tool_call", handler, { priority: 90 });

  api.on("gateway_stop", async () => {
    // Guard double-close: remove from registry before ending the pool so a
    // second gateway_stop (possible with duplicate registration) is a no-op.
    const pool = await poolResolvePromise?.catch(() => undefined);
    if (pool === undefined) {
      return;
    }

    // Find and evict this pool from the singleton registry before ending it.
    for (const [dsn, p] of poolsByDsn.entries()) {
      if (p === pool) {
        poolsByDsn.delete(dsn);
        break;
      }
    }
    await pool.end();
  });

  api.logger.info?.(`[henry-policy] tool policy active; cache TTL ${config.cacheTtlSeconds}s`);
}
