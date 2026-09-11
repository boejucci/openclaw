import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { Pool as PgPool } from "pg";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { registerHenryContext } from "./src/register.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let dsnCounter = 0;
function uniqueDsn(): string {
  return `postgres://localhost/henry_ctx_test_${++dsnCounter}`;
}

function buildPluginConfig(dsn?: string): Record<string, unknown> {
  return { db: { dsn: dsn ?? uniqueDsn() } };
}

function makeFakePool(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  const end = vi.fn().mockResolvedValue(undefined);
  const pool = { query, end } as unknown as PgPool;
  return { pool, query, end };
}

type CapturedRoute = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

function buildTestApi(pluginConfig: Record<string, unknown> = buildPluginConfig()) {
  const on = vi.fn();
  const registerHttpRoute = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const resolvePath = vi.fn((_input: string) => "/test/workspace");

  const api = createTestPluginApi({
    id: "henry-context",
    name: "Henry Context",
    source: "test",
    config: {},
    pluginConfig,
    on,
    registerHttpRoute,
    resolvePath,
    logger: { info, warn, error },
  });

  return { api, on, registerHttpRoute, info, warn, error, resolvePath };
}

function findRegisteredRoute(registerHttpRoute: ReturnType<typeof vi.fn>): CapturedRoute {
  const call = registerHttpRoute.mock.calls[0];
  if (!call) {
    throw new Error("No route was registered");
  }
  return call[0] as CapturedRoute;
}

// Build a synthetic IncomingMessage-like object for route handler tests.
function makeRequest(
  method: string,
  body: unknown,
  opts: { remoteAddress?: string; proxied?: boolean } = {},
): IncomingMessage {
  const chunks: Buffer[] = [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
    headers: opts.proxied ? { "x-forwarded-for": "1.2.3.4" } : {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === "data") {
        for (const c of chunks) {
          cb(c);
        }
      }
      if (event === "end") {
        cb();
      }
      return this;
    },
  } as unknown as IncomingMessage;
  return req;
}

type TestResponse = ServerResponse & { capturedStatus: number; capturedBody: string };

function makeResponse(): TestResponse {
  let capturedStatus = 0;
  let capturedBody = "";
  const res = {
    statusCode: 0,
    setHeader: vi.fn(),
    end(data: string) {
      capturedBody = data;
      capturedStatus = res.statusCode;
    },
    get capturedStatus() {
      return capturedStatus;
    },
    get capturedBody() {
      return capturedBody;
    },
  } as unknown as TestResponse;
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("henry-context plugin", () => {
  it("registers before_prompt_build with priority 80", () => {
    const { pool } = makeFakePool();
    const { api, on } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const call = on.mock.calls.find(([name]: [string]) => name === "before_prompt_build");
    expect(call).toBeDefined();
    expect(call![2]).toEqual({ priority: 80 });
  });

  it("registers agent_end when memoryFlushEnabled is true (default)", () => {
    const { pool } = makeFakePool();
    const { api, on } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const endCall = on.mock.calls.find(([name]: [string]) => name === "agent_end");
    expect(endCall).toBeDefined();
  });

  it("does NOT register agent_end when memoryFlushEnabled is false", () => {
    const { pool } = makeFakePool();
    const { api, on } = buildTestApi({ db: { dsn: uniqueDsn() }, memoryFlushEnabled: false });

    registerHenryContext(api, { pgClient: pool });

    const endCall = on.mock.calls.find(([name]: [string]) => name === "agent_end");
    expect(endCall).toBeUndefined();
  });

  it("registers the cache-invalidate HTTP route once", () => {
    const { pool } = makeFakePool();
    const { api, registerHttpRoute } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const route = registerHttpRoute.mock.calls[0]?.[0];
    expect(route?.path).toBe("/henry/context/invalidate");
    expect(route?.auth).toBe("plugin");
    expect(route?.match).toBe("exact");
  });

  it("throws on invalid config (missing db.dsn)", () => {
    const { api } = buildTestApi({});
    expect(() => registerHenryContext(api, {})).toThrow();
  });

  it("plugin.register delegates to registerHenryContext (smoke)", () => {
    const { api, on } = buildTestApi();
    plugin.register(api);
    const promptCall = on.mock.calls.find(([name]: [string]) => name === "before_prompt_build");
    expect(promptCall).toBeDefined();
  });

  // ── Invalidate route tests ─────────────────────────────────────────────────

  it("invalidate route: { scope: 'team' } returns 200 { ok: true }", async () => {
    const { pool } = makeFakePool([{ content_md: "team content", updated_at: new Date() }]);
    const { api, registerHttpRoute } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const route = findRegisteredRoute(registerHttpRoute);
    const req = makeRequest("POST", { scope: "team" });
    const res = makeResponse();
    await route.handler(req, res);

    expect(res.capturedStatus).toBe(200);
    expect(JSON.parse(res.capturedBody)).toEqual({ ok: true });
  });

  it("invalidate route: { scope: 'speaker', profileId: 'profile-ada' } — returns 200", async () => {
    const { pool } = makeFakePool();
    const { api, registerHttpRoute } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const route = findRegisteredRoute(registerHttpRoute);
    const req = makeRequest("POST", { scope: "speaker", profileId: "profile-ada" });
    const res = makeResponse();
    await route.handler(req, res);

    expect(res.capturedStatus).toBe(200);
    expect(JSON.parse(res.capturedBody)).toEqual({ ok: true });
  });

  it("invalidate route: non-loopback address → 403 loopback_only", async () => {
    const { pool } = makeFakePool();
    const { api, registerHttpRoute } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const route = findRegisteredRoute(registerHttpRoute);
    const req = makeRequest("POST", { scope: "team" }, { remoteAddress: "203.0.113.5" });
    const res = makeResponse();
    await route.handler(req, res);

    expect(res.capturedStatus).toBe(403);
    expect(JSON.parse(res.capturedBody)).toMatchObject({ error: "loopback_only" });
  });

  it("invalidate route: proxied loopback request → 403 loopback_only", async () => {
    const { pool } = makeFakePool();
    const { api, registerHttpRoute } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const route = findRegisteredRoute(registerHttpRoute);
    const req = makeRequest(
      "POST",
      { scope: "team" },
      { remoteAddress: "127.0.0.1", proxied: true },
    );
    const res = makeResponse();
    await route.handler(req, res);

    expect(res.capturedStatus).toBe(403);
    expect(JSON.parse(res.capturedBody)).toMatchObject({ error: "loopback_only" });
  });

  it("invalidate route: { scope: 'speaker' } without profileId → 400 profileId_required", async () => {
    const { pool } = makeFakePool();
    const { api, registerHttpRoute } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const route = findRegisteredRoute(registerHttpRoute);
    const req = makeRequest("POST", { scope: "speaker" });
    const res = makeResponse();
    await route.handler(req, res);

    expect(res.capturedStatus).toBe(400);
    expect(JSON.parse(res.capturedBody)).toMatchObject({ error: "profileId_required" });
  });

  it("invalidate route: non-POST method → 405", async () => {
    const { pool } = makeFakePool();
    const { api, registerHttpRoute } = buildTestApi();

    registerHenryContext(api, { pgClient: pool });

    const route = findRegisteredRoute(registerHttpRoute);
    const req = makeRequest("GET", {});
    const res = makeResponse();
    await route.handler(req, res);

    expect(res.capturedStatus).toBe(405);
  });

  // ── Full-stack integration: prompt hook returns prependSystemContext ────────

  it("full-stack: stub db returns team context + person; prompt hook returns prependSystemContext with name and team content", async () => {
    const teamRow = { content_md: "Team background text.", updated_at: new Date() };
    const personRow = {
      profile_id: "profile-ada",
      display_name: "Ada Lovelace",
      role: "admin",
      context_md: "Ada prefers concise answers.",
    };
    const memoryRows: unknown[] = [];

    const { pool, query } = makeFakePool();
    // Each pool.query call returns different data based on the SQL.
    query.mockImplementation((sql: string) => {
      if (sql.includes("henry_team_context")) {
        return Promise.resolve({ rows: [teamRow] });
      }
      if (sql.includes("henry_people")) {
        return Promise.resolve({ rows: [personRow] });
      }
      if (sql.includes("henry_memory")) {
        return Promise.resolve({ rows: memoryRows });
      }
      return Promise.resolve({ rows: [] });
    });

    const { api, on } = buildTestApi();
    registerHenryContext(api, { pgClient: pool });

    // Find the before_prompt_build handler
    const hookCall = on.mock.calls.find(([name]: [string]) => name === "before_prompt_build");
    expect(hookCall).toBeDefined();
    const handler = hookCall![1] as (
      event: { prompt: string },
      ctx: { senderId?: string },
    ) => Promise<{ prependSystemContext?: string } | undefined>;

    const result = await handler({ prompt: "Hello" }, { senderId: "profile-ada" });

    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toBeDefined();
    const ctx = result?.prependSystemContext ?? "";
    expect(ctx).toContain("Ada Lovelace");
    expect(ctx).toContain("Team background text.");
    expect(ctx).toContain("--- Henry Context ---");
  });
});
