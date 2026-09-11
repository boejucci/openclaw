import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { Pool as PgPool } from "pg";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { registerHenryPolicy } from "./src/register.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CapturedHandler = (
  event: { toolName: string; params: Record<string, unknown> },
  ctx: { requester?: { senderId?: string } },
) => Promise<unknown>;

type CapturedStopHandler = () => Promise<void>;

// Each test that touches poolsByDsn (module-level singleton) must use a unique
// DSN so tests don't share pools across runs.  Use a counter to vary it.
let dsnCounter = 0;
function uniqueDsn(): string {
  return `postgres://localhost/henry_test_${++dsnCounter}`;
}

function buildPluginConfig(dsn?: string): Record<string, unknown> {
  return { db: { dsn: dsn ?? uniqueDsn() } };
}

// Standalone fns returned alongside the pool so assertions reference locals,
// never member expressions (typescript/unbound-method).
function makeFakePool() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const end = vi.fn().mockResolvedValue(undefined);
  const pool = { query, end } as unknown as PgPool;
  return { pool, query, end };
}

// Returns a Pool constructor that, when called with `new`, returns fakePool.
// vi.fn() as a class constructor returns `this` (a new object), not the return
// value of the implementation callback, so we use a real function instead.
function makePoolCtor(fakePool: PgPool): typeof PgPool {
  const ctor = vi.fn(function (this: unknown) {
    return fakePool;
  });
  return ctor as unknown as typeof PgPool;
}

function buildTestApi(pluginConfig: Record<string, unknown> = buildPluginConfig()) {
  const on = vi.fn();
  const info = vi.fn();
  const api = createTestPluginApi({
    id: "henry-policy",
    name: "Henry Policy",
    source: "test",
    config: {},
    pluginConfig,
    on,
    logger: { info, warn: vi.fn(), error: vi.fn() },
  });
  return { api, on, info };
}

function findHook(on: ReturnType<typeof vi.fn>, hookName: string): CapturedHandler {
  const call = on.mock.calls.find(([name]: [string]) => name === hookName);
  if (!call || typeof call[1] !== "function") {
    throw new Error(`${hookName} was not registered`);
  }
  return call[1] as CapturedHandler;
}

function findStopHook(on: ReturnType<typeof vi.fn>): CapturedStopHandler {
  const call = on.mock.calls.find(([name]: [string]) => name === "gateway_stop");
  if (!call || typeof call[1] !== "function") {
    throw new Error("gateway_stop was not registered");
  }
  return call[1] as CapturedStopHandler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const personRow = {
  profile_id: "profile-joe",
  email: "jbucci@isidefense.com",
  display_name: "Joe Bucci",
  role: "admin",
  access: { defaultVerdict: "allow", rules: [] },
};

describe("henry-policy plugin", () => {
  it("registers before_tool_call with priority 90 and no matcher", () => {
    const { pool: fakePool } = makeFakePool();
    const PoolCtor = makePoolCtor(fakePool);
    const { api, on } = buildTestApi();

    registerHenryPolicy(api, { Pool: PoolCtor });

    expect(on).toHaveBeenCalledWith("before_tool_call", expect.any(Function), { priority: 90 });
    // no matcher key in the options object
    const call = on.mock.calls.find(([n]: [string]) => n === "before_tool_call")!;
    expect(call[2]).not.toHaveProperty("matcher");
  });

  it("registers gateway_stop", () => {
    const { pool: fakePool } = makeFakePool();
    const PoolCtor = makePoolCtor(fakePool);
    const { api, on } = buildTestApi();

    registerHenryPolicy(api, { Pool: PoolCtor });

    expect(on).toHaveBeenCalledWith("gateway_stop", expect.any(Function));
  });

  it("before_tool_call returns undefined (allow) for a person with defaultVerdict allow", async () => {
    const { pool: fakePool, query } = makeFakePool();
    query.mockResolvedValue({
      rows: [personRow],
    } as unknown as Awaited<ReturnType<PgPool["query"]>>);

    const PoolCtor = makePoolCtor(fakePool);
    const { api, on } = buildTestApi();

    registerHenryPolicy(api, { Pool: PoolCtor });

    const handler = findHook(on, "before_tool_call");
    const result = await handler(
      { toolName: "read", params: {} },
      { requester: { senderId: "profile-joe" } },
    );

    expect(result).toBeUndefined();
  });

  it("gateway_stop calls pool.end()", async () => {
    const { pool: fakePool, query, end } = makeFakePool();
    query.mockResolvedValue({
      rows: [personRow],
    } as unknown as Awaited<ReturnType<PgPool["query"]>>);

    const PoolCtor = makePoolCtor(fakePool);
    const { api, on } = buildTestApi();

    registerHenryPolicy(api, { Pool: PoolCtor });

    // Trigger pool creation by invoking the before_tool_call handler once
    const handler = findHook(on, "before_tool_call");
    await handler({ toolName: "read", params: {} }, { requester: { senderId: "profile-joe" } });

    const stopHandler = findStopHook(on);
    await stopHandler();

    expect(end).toHaveBeenCalledTimes(1);
  });

  it("throws out of register when db key is missing in pluginConfig", () => {
    const { api } = buildTestApi({});

    expect(() => registerHenryPolicy(api, {})).toThrow();
  });

  it("plugin.register delegates to registerHenryPolicy (smoke)", () => {
    const { api, on } = buildTestApi();
    plugin.register(api);
    expect(on).toHaveBeenCalledWith("before_tool_call", expect.any(Function), { priority: 90 });
  });

  // MF-W2-2: DSN failure recovery behavior
  it("DSN resolution failure → block (fail-closed)", async () => {
    const { api, on } = buildTestApi();

    const failingResolve = vi.fn().mockRejectedValue(new Error("DSN unavailable"));
    registerHenryPolicy(api, { resolveSecret: failingResolve });

    const handler = findHook(on, "before_tool_call");
    const result = await handler(
      { toolName: "read", params: {} },
      { requester: { senderId: "profile-joe" } },
    );
    expect(result).toMatchObject({ block: true });
  });

  it("DSN failure: call within 30s window blocks WITHOUT re-attempting resolution", async () => {
    const { api, on } = buildTestApi();
    let t = 0;
    const now = () => t;
    const failingResolve = vi.fn().mockRejectedValue(new Error("DSN unavailable"));
    registerHenryPolicy(api, { resolveSecret: failingResolve, now });

    const handler = findHook(on, "before_tool_call");

    // First call triggers resolution attempt, which fails
    t = 0;
    await handler({ toolName: "read", params: {} }, { requester: { senderId: "profile-joe" } });
    expect(failingResolve).toHaveBeenCalledTimes(1);

    // Second call within 30s window should block without re-attempting
    t = 15_000; // 15s later — within the 30s gap
    await handler({ toolName: "read", params: {} }, { requester: { senderId: "profile-joe" } });
    expect(failingResolve).toHaveBeenCalledTimes(1); // no second attempt
  });

  it("DSN failure: call after 30s with resolution succeeding → policy evaluates normally", async () => {
    const { pool: fakePool, query } = makeFakePool();
    query.mockResolvedValue({
      rows: [personRow],
    } as unknown as Awaited<ReturnType<PgPool["query"]>>);
    const PoolCtor = makePoolCtor(fakePool);

    const { api, on } = buildTestApi();
    let t = 0;
    const now = () => t;
    const resolveSecret = vi
      .fn()
      .mockRejectedValueOnce(new Error("DSN unavailable"))
      .mockResolvedValue(uniqueDsn());
    registerHenryPolicy(api, { resolveSecret, now, Pool: PoolCtor });

    const handler = findHook(on, "before_tool_call");

    // First call fails
    t = 0;
    const first = await handler(
      { toolName: "read", params: {} },
      { requester: { senderId: "profile-joe" } },
    );
    expect(first).toMatchObject({ block: true });

    // After 30s, resolution succeeds and policy evaluates normally
    t = 31_000;
    const second = await handler(
      { toolName: "read", params: {} },
      { requester: { senderId: "profile-joe" } },
    );
    expect(second).toBeUndefined(); // allow (defaultVerdict allow from personRow)
  });

  it("duplicate registration with same DSN creates ONE pool (singleton by DSN)", async () => {
    const { pool: fakePool, query } = makeFakePool();
    query.mockResolvedValue({
      rows: [personRow],
    } as unknown as Awaited<ReturnType<PgPool["query"]>>);

    // Shared DSN — both registrations must resolve to the same pool instance.
    const sharedDsn = uniqueDsn();
    const sharedConfig = buildPluginConfig(sharedDsn);

    // Single pool constructor to track instantiation count across both registrations.
    const PoolCtor = makePoolCtor(fakePool);

    const { api: api1, on: on1 } = buildTestApi(sharedConfig);
    const { api: api2, on: on2 } = buildTestApi(sharedConfig);

    // Register twice with the same DSN
    registerHenryPolicy(api1, { Pool: PoolCtor });
    registerHenryPolicy(api2, { Pool: PoolCtor });

    // Fire the before_tool_call handler on each api to trigger pool creation
    const handler1 = findHook(on1, "before_tool_call");
    const handler2 = findHook(on2, "before_tool_call");

    await handler1({ toolName: "read", params: {} }, { requester: { senderId: "profile-joe" } });
    await handler2({ toolName: "read", params: {} }, { requester: { senderId: "profile-joe" } });

    // The Pool constructor must have been called exactly once: the second
    // register() call finds the pool for this DSN in poolsByDsn and reuses it.
    expect(PoolCtor).toHaveBeenCalledTimes(1);
  });
});
