import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDecisionLogger, digestParams } from "./logger.js";

function makePool(queryImpl?: () => Promise<unknown>): Pool {
  return {
    query: vi.fn(queryImpl ?? (() => Promise.resolve({ rows: [] }))),
  } as unknown as Pool;
}

describe("createDecisionLogger", () => {
  it("log() is synchronous — does not block caller; query is called after a tick", async () => {
    const pool = makePool();
    const logger = createDecisionLogger({ pool });

    logger.log({ profileId: "p1", tool: "exec", params: {}, verdict: "allow", reason: "default" });

    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    await Promise.resolve();

    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("log() calls query with [profileId, tool, digest, verdict, reason]", async () => {
    const pool = makePool();
    const logger = createDecisionLogger({ pool });
    const params = { key: "value" };

    logger.log({
      profileId: "p1",
      tool: "exec",
      params,
      verdict: "allow",
      reason: "mcp:monday:*",
    });

    await Promise.resolve();

    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toEqual(["p1", "exec", digestParams(params), "allow", "mcp:monday:*"]);
  });

  it("a thrown query does not propagate to the caller", async () => {
    const pool = makePool(() => Promise.reject(new Error("db down")));
    const logger = createDecisionLogger({ pool });

    expect(() => {
      logger.log({ profileId: "p1", tool: "exec", params: {}, verdict: "deny", reason: "default" });
    }).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
  });

  it("enabled: false → query never called", async () => {
    const pool = makePool();
    const logger = createDecisionLogger({ pool, enabled: false });

    logger.log({ profileId: "p1", tool: "read", params: {}, verdict: "allow", reason: "default" });

    await Promise.resolve();

    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("profile_id is null when entry.profileId is null", async () => {
    const pool = makePool();
    const logger = createDecisionLogger({ pool });

    logger.log({
      profileId: null,
      tool: "exec",
      params: {},
      verdict: "block_no_principal",
      reason: "no_principal",
    });

    await Promise.resolve();

    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1][0]).toBeNull();
  });
});

describe("digestParams", () => {
  it("returns a 16-character hex string for various inputs", () => {
    for (const input of [{}, { a: 1 }, null, undefined, "string", 42, []]) {
      const result = digestParams(input);
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("does not include the input value in the result (only length and hex chars checked)", () => {
    const sensitiveInput = { token: "super-secret-value-should-not-appear" };
    const result = digestParams(sensitiveInput);
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
});
