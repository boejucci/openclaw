import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { Pool as PgPool } from "pg";
import { z } from "zod";
import { createHenryContextDb } from "./db.js";
import { createEndHook } from "./end-hook.js";
import { createPromptHook } from "./prompt-hook.js";

// ── Loopback guard (mirrors henry-sf credential-route pattern) ────────────────

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXIED_REQUEST_HEADERS = [
  "x-forwarded-for",
  "cf-connecting-ip",
  "cf-ray",
  "cf-access-jwt-assertion",
];

function isLoopbackRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) {
    return false;
  }
  return !PROXIED_REQUEST_HEADERS.some((name) => req.headers[name] !== undefined);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// ── Config schema (matches openclaw.plugin.json — db.dsn, not pgConnectionString) ──

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec", "store"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const henryContextConfigSchema = z
  .object({
    db: z
      .object({
        dsn: z.union([z.string().trim().min(1), secretRefSchema]),
        poolMax: z.number().int().min(1).max(10).default(2),
      })
      .strict(),
    teamContextTtlMs: z.number().int().min(0).default(600_000),
    speakerTtlMs: z.number().int().min(0).default(300_000),
    staleTtlMs: z.number().int().min(0).default(1_800_000),
    teamTokenBudget: z.number().int().min(100).default(2_000),
    speakerTokenBudget: z.number().int().min(100).default(1_000),
    memoryItemLimit: z.number().int().min(1).default(10),
    memoryFlushEnabled: z.boolean().default(true),
    invalidateRoutePath: z.string().default("/henry/context/invalidate"),
  })
  .strict();

type HenryContextConfig = z.infer<typeof henryContextConfigSchema>;

// ── Module-scope pool singleton — keyed by resolved DSN ──────────────────────
//
// Same pattern as henry-policy: the gateway loader can register() more than
// once per process (duplicate discovery roots). Keying by DSN means two
// identical configurations share one pool. This is henry-context's OWN map;
// it does NOT import or share henry-policy's poolsByDsn.

const poolsByDsn = new Map<string, PgPool>();

// ── Deps type (for test injection) ───────────────────────────────────────────

export type HenryContextDeps = {
  pgClient?: unknown; // injected in tests (Pool constructor or stub db)
  now?: () => number;
};

// ── DSN resolution helper ─────────────────────────────────────────────────────

function createDsnResolver(
  api: OpenClawPluginApi,
  config: HenryContextConfig,
): () => Promise<string> {
  return async () => {
    const configPath = "plugins.entries.henry-context.config.db.dsn";
    const resolved = await resolveConfiguredSecretInputString({
      config: api.config,
      env: process.env,
      value: config.db.dsn,
      path: configPath,
    });
    if (resolved.value === undefined) {
      throw new Error(
        `henry-context: db.dsn did not resolve: ${resolved.unresolvedRefReason ?? "unknown reason"}`,
      );
    }
    return resolved.value;
  };
}

// ── Register function ─────────────────────────────────────────────────────────

export function registerHenryContext(api: OpenClawPluginApi, deps: HenryContextDeps = {}): void {
  // 1. Parse config — throw on invalid so the gateway startup reports a clear error.
  const parseResult = henryContextConfigSchema.safeParse(api.pluginConfig);
  if (!parseResult.success) {
    const first = parseResult.error.issues[0];
    const cfgPath = first?.path.length
      ? `plugins.entries.henry-context.config.${first.path.join(".")}`
      : "plugins.entries.henry-context.config";
    throw new Error(`${cfgPath}: ${first?.message ?? parseResult.error.message}`);
  }
  const config: HenryContextConfig = parseResult.data;

  // 2. Build lazy pool + db.
  //
  // Pool creation is lazy (same pattern as henry-policy): a missing Postgres at
  // startup does not crash the Gateway. On failure, the prompt hook returns
  // undefined (no injection) and logs a rate-limited warn — the turn is NEVER blocked.
  let poolResolvePromise: Promise<PgPool> | undefined;
  let lastFailureTime: number | undefined;
  const RETRY_DELAY_MS = 30_000;

  function now(): number {
    return deps.now ? deps.now() : Date.now();
  }

  const resolveDsn = createDsnResolver(api, config);

  function getOrCreatePool(): Promise<PgPool> {
    if (poolResolvePromise !== undefined) {
      return poolResolvePromise;
    }

    // Within the retry window after a failure: fail open (return undefined),
    // not closed — context hooks must NEVER block a turn.
    if (lastFailureTime !== undefined && now() - lastFailureTime < RETRY_DELAY_MS) {
      return Promise.reject(new Error("henry-context: DSN resolution failed; retrying after 30s"));
    }

    poolResolvePromise = resolveDsn().then((dsn) => {
      const existing = poolsByDsn.get(dsn);
      if (existing !== undefined) {
        return existing;
      }

      let pool: PgPool;
      if (deps.pgClient !== undefined) {
        // Test injection: accept a Pool instance directly.
        pool = deps.pgClient as PgPool;
      } else {
        const PgPoolCtor: typeof PgPool = (require("pg") as { Pool: typeof PgPool }).Pool;
        pool = new PgPoolCtor({ connectionString: dsn, max: config.db.poolMax });
      }
      poolsByDsn.set(dsn, pool);
      return pool;
    });

    poolResolvePromise = poolResolvePromise.catch((err: unknown) => {
      lastFailureTime = now();
      poolResolvePromise = undefined;
      throw err;
    });

    return poolResolvePromise;
  }

  // dbInstance is lifted to the outer scope so gateway_stop can nullify it,
  // preventing post-stop hook invocations from hitting a closed pool.
  let dbInstance: ReturnType<typeof createHenryContextDb> | undefined;

  // Create db lazily via a proxy so pool resolution failures degrade gracefully.
  const db: ReturnType<typeof createHenryContextDb> = (() => {
    async function getInstance(): Promise<ReturnType<typeof createHenryContextDb>> {
      if (dbInstance !== undefined) {
        return dbInstance;
      }
      const pool = await getOrCreatePool();
      dbInstance = createHenryContextDb({
        pool,
        teamTtlMs: config.teamContextTtlMs,
        speakerTtlMs: config.speakerTtlMs,
        staleTtlMs: config.staleTtlMs,
        now: deps.now,
        warn: (msg) => api.logger.warn(msg),
        memoryItemLimit: config.memoryItemLimit,
      });
      return dbInstance;
    }

    return {
      async getTeamContext() {
        const instance = await getInstance();
        return instance.getTeamContext();
      },
      async getPerson(profileId) {
        const instance = await getInstance();
        return instance.getPerson(profileId);
      },
      async getMemory(profileId, limit) {
        const instance = await getInstance();
        return instance.getMemory(profileId, limit);
      },
      async writeMemory(row) {
        const instance = await getInstance();
        return instance.writeMemory(row);
      },
      invalidateTeam() {
        dbInstance?.invalidateTeam();
      },
      invalidateSpeaker(profileId) {
        dbInstance?.invalidateSpeaker(profileId);
      },
    };
  })();

  // 3. Build workspaceFallback.
  //
  // The spec's step 3 uses api.workspace?.appendToFile — that property does not
  // exist on OpenClawPluginApi. We implement it via node:fs writes. api.resolvePath
  // is used to locate the agent workspace root. If resolvePath throws or produces
  // a non-absolute result, we warn once and skip fallback writes.
  let workspaceFallbackWarnedOnce = false;
  let workspaceRoot: string | undefined;

  function getWorkspaceRoot(): string | undefined {
    if (workspaceRoot !== undefined) {
      return workspaceRoot;
    }
    try {
      const resolved = api.resolvePath(".");
      if (resolved && path.isAbsolute(resolved)) {
        workspaceRoot = resolved;
        return workspaceRoot;
      }
    } catch {
      // fall through
    }
    if (!workspaceFallbackWarnedOnce) {
      workspaceFallbackWarnedOnce = true;
      api.logger.warn(
        "[henry-context] workspace root unavailable; memory fallback writes disabled",
      );
    }
    return undefined;
  }

  const workspaceFallback = async (profileId: string, content: string): Promise<void> => {
    const root = getWorkspaceRoot();
    if (root === undefined) {
      throw new Error("henry-context: workspace root unavailable for fallback write");
    }
    const date = new Date().toISOString().slice(0, 10);
    const memoryDir = path.join(root, "memory");
    const filePath = path.join(memoryDir, `${date}.md`);
    await fs.mkdir(memoryDir, { recursive: true });
    const line = `\n- [henry-context] ${date} ${profileId}: ${content}\n`;
    await fs.appendFile(filePath, line, "utf8");
  };

  // 4. getLastMemoryContent — for end-hook dedup.
  const getLastMemoryContent = async (profileId: string): Promise<string | null> => {
    try {
      const pool = await getOrCreatePool();
      const result = await pool.query<{ content: string }>(
        "SELECT content FROM henry_memory WHERE profile_id = $1 ORDER BY at DESC LIMIT 1",
        [profileId],
      );
      if (result.rows.length === 0) {
        return null;
      }
      return result.rows[0]?.content ?? null;
    } catch {
      return null;
    }
  };

  // 5. Register before_prompt_build hook (priority 80).
  //    NEVER-BLOCK contract: on pool/DSN failure, the proxy returns null/[]
  //    which assembleContextBlock handles as "inject nothing" (text === "").
  const promptHook = createPromptHook({
    db,
    teamTokenBudget: config.teamTokenBudget,
    speakerTokenBudget: config.speakerTokenBudget,
    memoryItemLimit: config.memoryItemLimit,
  });

  api.on("before_prompt_build", promptHook, { priority: 80 });

  // 6. Register agent_end hook (if flush enabled).
  if (config.memoryFlushEnabled) {
    const endHook = createEndHook({
      db,
      workspaceFallback,
      flushEnabled: config.memoryFlushEnabled,
      getLastMemoryContent,
      logger: api.logger,
    });
    api.on("agent_end", endHook);
  }

  // 7. Register cache-invalidate HTTP route.
  //    Loopback-only (mirrors henry-sf credential-route guard).
  const invalidatePath = config.invalidateRoutePath;

  api.registerHttpRoute({
    path: invalidatePath,
    auth: "plugin",
    match: "exact",
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return true;
      }

      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: "loopback_only" });
        return true;
      }

      // Read and parse body.
      let body: unknown;
      try {
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => resolve());
          req.on("error", reject);
        });
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return true;
      }

      const parsed = z
        .object({
          scope: z.enum(["team", "speaker", "all"]),
          profileId: z.string().optional(),
        })
        .safeParse(body);

      if (!parsed.success) {
        sendJson(res, 400, { error: "invalid_body" });
        return true;
      }

      const { scope, profileId } = parsed.data;

      if (scope === "team") {
        db.invalidateTeam();
      } else if (scope === "speaker") {
        if (profileId === undefined) {
          sendJson(res, 400, { error: "profileId_required" });
          return true;
        }
        db.invalidateSpeaker(profileId);
      } else if (scope === "all") {
        db.invalidateTeam();
        if (profileId !== undefined) {
          db.invalidateSpeaker(profileId);
        }
        // "all" without a profileId invalidates team only (no per-profile clear needed
        // without a profileId; the TTL will expire stale entries naturally).
      }

      sendJson(res, 200, { ok: true });
      return true;
    },
  });

  // 8. Gateway stop: clean up pool.
  // Nullify dbInstance so any post-stop hook invocation hits getOrCreatePool()
  // (which will fail gracefully via lastFailureTime) rather than calling methods
  // on a db wrapping a now-ended pool.
  api.on("gateway_stop", async () => {
    dbInstance = undefined;
    const pool = await poolResolvePromise?.catch(() => undefined);
    if (pool === undefined) {
      return;
    }
    for (const [dsn, p] of poolsByDsn.entries()) {
      if (p === pool) {
        poolsByDsn.delete(dsn);
        break;
      }
    }
    await pool.end();
  });

  api.logger.info?.(`[henry-context] loaded; flush=${config.memoryFlushEnabled}`);
}
