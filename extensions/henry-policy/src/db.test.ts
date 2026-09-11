import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createHenryDb, type PersonRow } from "./db.js";

type MockPool = {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function buildPool(overrides: Partial<MockPool> = {}): MockPool {
  return {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const row: PersonRow = {
  profileId: "profile-1",
  email: "alice@isi.example",
  displayName: "Alice",
  role: "member",
  access: { defaultVerdict: "deny", rules: [] },
};

function dbRow() {
  return {
    profile_id: row.profileId,
    email: row.email,
    display_name: row.displayName,
    role: row.role,
    access: row.access,
  };
}

describe("createHenryDb", () => {
  it("first call queries the DB and caches the result", async () => {
    const pool = buildPool({
      query: vi.fn().mockResolvedValue({ rows: [dbRow()] }),
    });
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 60_000 });

    const result = await db.getPerson(row.profileId);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ profileId: row.profileId, email: row.email });
  });

  it("second call within TTL returns cached row without re-querying", async () => {
    const pool = buildPool({
      query: vi.fn().mockResolvedValue({ rows: [dbRow()] }),
    });
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 60_000 });

    await db.getPerson(row.profileId);
    await db.getPerson(row.profileId);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("call after TTL expiry re-queries the DB", async () => {
    let currentMs = 0;
    const pool = buildPool({
      query: vi.fn().mockResolvedValue({ rows: [dbRow()] }),
    });
    const db = createHenryDb({
      pool: pool as unknown as Pool,
      cacheTtlMs: 60_000,
      now: () => currentMs,
    });

    await db.getPerson(row.profileId);
    currentMs = 60_001;
    await db.getPerson(row.profileId);

    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("not-found result caches null and next call within TTL returns null without re-querying", async () => {
    const pool = buildPool({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 60_000 });

    const first = await db.getPerson("unknown-profile");
    const second = await db.getPerson("unknown-profile");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("concurrent calls for the same profileId share one DB query", async () => {
    const pool = buildPool({
      query: vi.fn().mockResolvedValue({ rows: [dbRow()] }),
    });
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 60_000 });

    const [first, second] = await Promise.all([
      db.getPerson(row.profileId),
      db.getPerson(row.profileId),
    ]);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("query error propagates and nothing is cached; next call queries again", async () => {
    const pool = buildPool({
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("db error"))
        .mockResolvedValue({ rows: [dbRow()] }),
    });
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 60_000 });

    await expect(db.getPerson(row.profileId)).rejects.toThrow("db error");
    const result = await db.getPerson(row.profileId);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ profileId: row.profileId });
  });

  it("close() calls pool.end()", async () => {
    const pool = buildPool();
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 60_000 });

    await db.close();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("cacheTtlMs of 0 disables caching so every call queries", async () => {
    const pool = buildPool({
      query: vi.fn().mockResolvedValue({ rows: [dbRow()] }),
    });
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 0 });

    await db.getPerson(row.profileId);
    await db.getPerson(row.profileId);

    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  // Deliberate semantics (matches henry-sf's reviewed credential cache): TTL 0
  // disables result caching, but concurrent callers still share the one
  // in-progress query — an in-flight query can never serve stale data.
  it("cacheTtlMs of 0 still single-flights concurrent calls", async () => {
    let resolveQuery: (value: { rows: unknown[] }) => void = () => {};
    const pool = buildPool({
      query: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
      ),
    });
    const db = createHenryDb({ pool: pool as unknown as Pool, cacheTtlMs: 0 });

    const first = db.getPerson(row.profileId);
    const second = db.getPerson(row.profileId);
    resolveQuery({ rows: [dbRow()] });
    const [a, b] = await Promise.all([first, second]);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});
