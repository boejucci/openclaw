import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createHenryContextDb,
  type HenryMemoryItem,
  type HenryPeopleFact,
  type HenryTeamContext,
} from "./db.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

type MockPool = {
  query: ReturnType<typeof vi.fn>;
};

function buildPool(overrides: Partial<MockPool> = {}): MockPool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  };
}

const teamRow = {
  content_md: "ISI team background text",
  updated_at: new Date("2026-09-01T00:00:00Z"),
};

const expectedTeamContext: HenryTeamContext = {
  contentMd: "ISI team background text",
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

const personDbRow = {
  profile_id: "profile-ada",
  display_name: "Ada Lovelace",
  role: "admin" as const,
  context_md: "Salesforce admin, prefers morning standups",
};

const expectedPerson: HenryPeopleFact = {
  profileId: "profile-ada",
  displayName: "Ada Lovelace",
  role: "admin",
  contextMd: "Salesforce admin, prefers morning standups",
};

const memoryDbRows = [
  {
    id: "1001",
    at: new Date("2026-09-05T10:00:00Z"),
    kind: "session",
    content: "Discussed Q3 pipeline",
    source_session: "sess-abc",
  },
  {
    id: "1002",
    at: new Date("2026-09-04T09:00:00Z"),
    kind: "session",
    content: "Reviewed Salesforce reports",
    source_session: null,
  },
];

const expectedMemoryItems: HenryMemoryItem[] = [
  {
    id: BigInt(1001),
    at: new Date("2026-09-05T10:00:00Z"),
    kind: "session",
    content: "Discussed Q3 pipeline",
    sourceSession: "sess-abc",
  },
  {
    id: BigInt(1002),
    at: new Date("2026-09-04T09:00:00Z"),
    kind: "session",
    content: "Reviewed Salesforce reports",
  },
];

// ── Test 1: Team context TTL ──────────────────────────────────────────────────

describe("createHenryContextDb — getTeamContext", () => {
  it("two calls within teamTtlMs hit the pool once", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [teamRow] });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, teamTtlMs: 60_000 });

    const first = await db.getTeamContext();
    const second = await db.getTeamContext();

    expect(query).toHaveBeenCalledTimes(1);
    expect(first).toEqual(expectedTeamContext);
    expect(second).toEqual(expectedTeamContext);
  });
});

// ── Test 2: Speaker TTL ───────────────────────────────────────────────────────

describe("createHenryContextDb — getPerson", () => {
  it("two calls for the same profileId within speakerTtlMs hit the pool twice (person+memory), then cache", async () => {
    // First call: 2 queries (person + memory). Second call: 0 queries (cache hit).
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [personDbRow] })
      .mockResolvedValueOnce({ rows: memoryDbRows })
      .mockResolvedValue({ rows: [] });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, speakerTtlMs: 60_000 });

    const first = await db.getPerson("profile-ada");
    const second = await db.getPerson("profile-ada");

    expect(query).toHaveBeenCalledTimes(2);
    expect(first).toEqual(expectedPerson);
    expect(second).toEqual(expectedPerson);
  });
});

// ── Test 3: Stale-on-error with stale entry ───────────────────────────────────

describe("createHenryContextDb — stale-on-error", () => {
  it("when pool throws and stale entry is within staleTtlMs, returns stale entry", async () => {
    let currentMs = 0;
    // First call succeeds and populates the cache.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [teamRow] })
      .mockRejectedValue(new Error("db error"));
    const pool = buildPool({ query });
    const db = createHenryContextDb({
      pool: pool as unknown as Pool,
      teamTtlMs: 1_000,
      staleTtlMs: 1_800_000,
      now: () => currentMs,
    });

    // Populate cache at t=0.
    const first = await db.getTeamContext();
    expect(first).toEqual(expectedTeamContext);

    // Advance past teamTtlMs so cache is stale, but within staleTtlMs.
    currentMs = 2_000;

    // Pool now throws — should return the stale entry.
    const second = await db.getTeamContext();
    expect(second).toEqual(expectedTeamContext);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

// ── Test 4: Stale-on-error with no cache → null ───────────────────────────────

describe("createHenryContextDb — stale-on-error no cache", () => {
  it("when pool throws and no cache exists, returns null", async () => {
    const query = vi.fn().mockRejectedValue(new Error("db error"));
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, teamTtlMs: 60_000 });

    const result = await db.getTeamContext();
    expect(result).toBeNull();
  });
});

// ── Test 5: Cache invalidation ────────────────────────────────────────────────

describe("createHenryContextDb — cache invalidation", () => {
  it("invalidateTeam forces the next call to hit the pool", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [teamRow] });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, teamTtlMs: 600_000 });

    await db.getTeamContext();
    expect(query).toHaveBeenCalledTimes(1);

    db.invalidateTeam();
    await db.getTeamContext();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("invalidateSpeaker forces the next getPerson call to hit the pool", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [personDbRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [personDbRow] })
      .mockResolvedValue({ rows: [] });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, speakerTtlMs: 600_000 });

    await db.getPerson("profile-ada");
    expect(query).toHaveBeenCalledTimes(2); // person + memory

    db.invalidateSpeaker("profile-ada");
    await db.getPerson("profile-ada");
    expect(query).toHaveBeenCalledTimes(4); // person + memory again
  });
});

// ── Test 6: Single-flight ─────────────────────────────────────────────────────

describe("createHenryContextDb — single-flight", () => {
  it("two concurrent getTeamContext calls resolve from one pending promise", async () => {
    let resolveQuery: (value: { rows: unknown[] }) => void = () => {};
    const query = vi.fn().mockReturnValue(
      new Promise<{ rows: unknown[] }>((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, teamTtlMs: 60_000 });

    const firstPromise = db.getTeamContext();
    const secondPromise = db.getTeamContext();
    resolveQuery({ rows: [teamRow] });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(first).toEqual(expectedTeamContext);
    expect(second).toEqual(expectedTeamContext);
  });

  it("two concurrent getPerson calls resolve from one pending promise (two queries total)", async () => {
    // getPerson fires person+memory in parallel; both calls share the same in-flight promise.
    let resolveQuery!: (value: { rows: unknown[] }) => void;
    let callCount = 0;
    const query = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // person query
        return new Promise<{ rows: unknown[] }>((resolve) => {
          resolveQuery = resolve;
        });
      }
      // memory query resolves immediately
      return Promise.resolve({ rows: [] });
    });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, speakerTtlMs: 60_000 });

    const firstPromise = db.getPerson("profile-ada");
    const secondPromise = db.getPerson("profile-ada");
    resolveQuery({ rows: [personDbRow] });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    // person + memory = 2 queries total (not 4), because second call hit the in-flight
    expect(query).toHaveBeenCalledTimes(2);
    expect(first).toEqual(expectedPerson);
    expect(second).toEqual(expectedPerson);
  });
});

// ── Test 7: writeMemory ───────────────────────────────────────────────────────

describe("createHenryContextDb — writeMemory", () => {
  it("calls pool.query with the correct INSERT params and does not cache the result", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool });

    const at = new Date("2026-09-05T12:00:00Z");
    await db.writeMemory({
      profileId: "profile-ada",
      at,
      kind: "session",
      content: "Key facts from today",
      sourceSession: "sess-xyz",
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, args] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO henry_memory");
    expect(args).toEqual(["profile-ada", at, "session", "Key facts from today", "sess-xyz"]);

    // writeMemory must not affect the speaker cache — a subsequent getPerson
    // call should still hit the pool (person + memory = 2 more queries).
    query.mockResolvedValueOnce({ rows: [personDbRow] }).mockResolvedValueOnce({ rows: [] });
    await db.getPerson("profile-ada");
    expect(query).toHaveBeenCalledTimes(3); // writeMemory + person + memory
  });

  it("getMemory returns mapped HenryMemoryItem array", async () => {
    const query = vi.fn().mockResolvedValue({ rows: memoryDbRows });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool });

    const items = await db.getMemory("profile-ada");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, args] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ORDER BY at DESC LIMIT");
    expect(args).toContain("profile-ada");
    expect(items).toHaveLength(2);
    expect(items).toEqual(expectedMemoryItems);
  });
});

// ── Test 8: Memory cache ──────────────────────────────────────────────────────

describe("createHenryContextDb — memory cache", () => {
  it("getMemory cache hit within speakerTtlMs: zero extra queries after getPerson", async () => {
    // getPerson fires person (1 query) + memory (1 query) = 2 total.
    // Subsequent getMemory within TTL hits the cache — no new query.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [personDbRow] })
      .mockResolvedValueOnce({ rows: memoryDbRows });
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, speakerTtlMs: 60_000 });

    await db.getPerson("profile-ada");
    expect(query).toHaveBeenCalledTimes(2);

    const memory = await db.getMemory("profile-ada");
    expect(query).toHaveBeenCalledTimes(2); // no new query
    expect(memory).toEqual(expectedMemoryItems);
  });

  it("stale memory on error: returns stale cached memory within staleTtlMs", async () => {
    let currentMs = 0;
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [personDbRow] })
      .mockResolvedValueOnce({ rows: memoryDbRows })
      .mockRejectedValue(new Error("db error"));
    const pool = buildPool({ query });
    const db = createHenryContextDb({
      pool: pool as unknown as Pool,
      speakerTtlMs: 1_000,
      staleTtlMs: 1_800_000,
      now: () => currentMs,
    });

    await db.getPerson("profile-ada");
    expect(query).toHaveBeenCalledTimes(2);

    currentMs = 2_000; // past speakerTtlMs, within staleTtlMs
    const memory = await db.getMemory("profile-ada");
    expect(memory).toEqual(expectedMemoryItems);
  });

  it("returns [] when no stale cache and pool throws", async () => {
    const query = vi.fn().mockRejectedValue(new Error("db error"));
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool });

    const memory = await db.getMemory("profile-ada");
    expect(memory).toEqual([]);
  });

  it("warn is called on read-path Postgres error", async () => {
    const query = vi.fn().mockRejectedValue(new Error("db error"));
    const pool = buildPool({ query });
    const warn = vi.fn();
    const db = createHenryContextDb({ pool: pool as unknown as Pool, warn });

    await db.getMemory("profile-ada");
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain("henry-context");
    // Must not contain row content or DSN
    expect(msg).not.toContain("profile-ada");
  });

  it("warn is rate-limited: two errors within 60s produce one warn", async () => {
    const currentMs = 0;
    const query = vi.fn().mockRejectedValue(new Error("db error"));
    const pool = buildPool({ query });
    const warn = vi.fn();
    const db = createHenryContextDb({
      pool: pool as unknown as Pool,
      warn,
      now: () => currentMs,
    });

    await db.getMemory("profile-ada");
    await db.getMemory("profile-ada");
    expect(warn).toHaveBeenCalledTimes(1); // rate-limited: same 60s window
  });
});

// ── Test 9: writeMemory timeout ───────────────────────────────────────────────

describe("createHenryContextDb — writeMemory timeout", () => {
  it("rejects with a descriptive error when the query hangs past queryTimeoutMs", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockReturnValue(new Promise(() => {})); // never settles
    const pool = buildPool({ query });
    const db = createHenryContextDb({ pool: pool as unknown as Pool, queryTimeoutMs: 100 });

    const writePromise = db.writeMemory({
      profileId: "profile-ada",
      at: new Date(),
      kind: "session",
      content: "test",
    });

    vi.advanceTimersByTime(200);
    await expect(writePromise).rejects.toThrow("timed out");
    vi.useRealTimers();
  });
});
