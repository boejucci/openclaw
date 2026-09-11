import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CachedContextDb, HenryPeopleFact, HenryMemoryItem } from "./db.ts";
import { createPromptHook } from "./prompt-hook.ts";

// ── Stub factory ──────────────────────────────────────────────────────────────

function makePerson(overrides?: Partial<HenryPeopleFact>): HenryPeopleFact {
  return {
    profileId: "profile-ada",
    displayName: "Ada",
    role: "member",
    contextMd: "Works on Salesforce.",
    ...overrides,
  };
}

function makeMemoryItem(content: string): HenryMemoryItem {
  return { id: 1n, at: new Date("2026-01-01"), kind: "session", content };
}

function makeDb(overrides?: Partial<CachedContextDb>): CachedContextDb {
  return {
    getTeamContext: vi
      .fn()
      .mockResolvedValue({ contentMd: "Team context.", updatedAt: new Date() }),
    getPerson: vi.fn().mockResolvedValue(makePerson()),
    getMemory: vi.fn().mockResolvedValue([makeMemoryItem("remembered fact")]),
    writeMemory: vi.fn().mockResolvedValue(undefined),
    invalidateTeam: vi.fn(),
    invalidateSpeaker: vi.fn(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createPromptHook", () => {
  let db: CachedContextDb;
  let hook: ReturnType<typeof createPromptHook>;

  beforeEach(() => {
    db = makeDb();
    hook = createPromptHook({
      db,
      teamTokenBudget: 2000,
      speakerTokenBudget: 1000,
      memoryItemLimit: 10,
    });
  });

  it("1. no senderId → team context only, no speaker block", async () => {
    const getPersonSpy = vi.fn(db.getPerson.bind(db));
    db.getPerson = getPersonSpy;
    const result = await hook({ prompt: "hello" }, {});
    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain("Team context.");
    expect(result?.prependSystemContext).not.toContain("## You");
    expect(getPersonSpy).not.toHaveBeenCalled();
  });

  it("2. senderId present, person found → full block returned", async () => {
    const result = await hook({ prompt: "hello" }, { senderId: "profile-ada" });
    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain("Team context.");
    expect(result?.prependSystemContext).toContain("Ada");
    expect(result?.prependSystemContext).toContain("## You");
    expect(result?.prependSystemContext).toContain("remembered fact");
  });

  it("3. senderId present, no person row → team only", async () => {
    db = makeDb({ getPerson: vi.fn().mockResolvedValue(null) });
    hook = createPromptHook({
      db,
      teamTokenBudget: 2000,
      speakerTokenBudget: 1000,
      memoryItemLimit: 10,
    });
    const result = await hook({ prompt: "hello" }, { senderId: "profile-unknown" });
    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain("Team context.");
    expect(result?.prependSystemContext).not.toContain("## You");
  });

  it("4. db.getTeamContext() throws → undefined returned", async () => {
    db = makeDb({ getTeamContext: vi.fn().mockRejectedValue(new Error("pg down")) });
    hook = createPromptHook({
      db,
      teamTokenBudget: 2000,
      speakerTokenBudget: 1000,
      memoryItemLimit: 10,
    });
    const result = await hook({ prompt: "hello" }, {});
    expect(result).toBeUndefined();
  });

  it("5. db.getPerson() throws → team context returned without speaker", async () => {
    db = makeDb({ getPerson: vi.fn().mockRejectedValue(new Error("pg error")) });
    hook = createPromptHook({
      db,
      teamTokenBudget: 2000,
      speakerTokenBudget: 1000,
      memoryItemLimit: 10,
    });
    const result = await hook({ prompt: "hello" }, { senderId: "profile-ada" });
    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain("Team context.");
    expect(result?.prependSystemContext).not.toContain("## You");
  });

  it("6. both empty → undefined", async () => {
    db = makeDb({
      getTeamContext: vi.fn().mockResolvedValue(null),
      getPerson: vi.fn().mockResolvedValue(null),
    });
    hook = createPromptHook({
      db,
      teamTokenBudget: 2000,
      speakerTokenBudget: 1000,
      memoryItemLimit: 10,
    });
    const result = await hook({ prompt: "hello" }, { senderId: "profile-ada" });
    expect(result).toBeUndefined();
  });

  it("7. assembled text is non-empty → returned as prependSystemContext", async () => {
    const result = await hook({ prompt: "anything" }, { senderId: "profile-ada" });
    expect(typeof result?.prependSystemContext).toBe("string");
    expect((result?.prependSystemContext ?? "").length).toBeGreaterThan(0);
  });
});
