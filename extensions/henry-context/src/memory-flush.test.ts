import { describe, expect, it, vi } from "vitest";
import { flushSessionMemory, type FlushInput, type FlushResult } from "./memory-flush.js";

function makeDb(impl?: () => Promise<void>) {
  return {
    writeMemory: vi.fn<() => Promise<void>>().mockImplementation(impl ?? (() => Promise.resolve())),
  };
}

function makeInput(overrides: Partial<FlushInput> = {}): FlushInput {
  return {
    profileId: "profile-ada",
    sessionKey: "session-abc",
    assistantTurns: ["Hello, how can I help you today?"],
    ...overrides,
  };
}

describe("flushSessionMemory", () => {
  it("returns skipped when assistantTurns is fewer than minTurns", async () => {
    const db = makeDb();
    const result = await flushSessionMemory(makeInput({ assistantTurns: [] }), { db, minTurns: 1 });
    expect(result.status).toBe("skipped");
    expect(db.writeMemory).not.toHaveBeenCalled();
  });

  it("returns skipped when summary is empty after truncation", async () => {
    const db = makeDb();
    // Provide a custom summarizer that returns empty string
    const summarize = vi.fn<(turns: readonly string[]) => string>().mockReturnValue("   ");
    const result = await flushSessionMemory(makeInput({ assistantTurns: ["some content"] }), {
      db,
      summarize,
    });
    expect(result.status).toBe("skipped");
    expect(db.writeMemory).not.toHaveBeenCalled();
  });

  it("returns wrote and calls writeMemory with correct params on happy path", async () => {
    const db = makeDb();
    const fixedDate = new Date("2026-09-05T12:00:00Z");
    const result = await flushSessionMemory(
      makeInput({ assistantTurns: ["I can help with that.", "Here is the answer."] }),
      { db, now: () => fixedDate },
    );
    expect(result.status).toBe("wrote");
    // wrote variant has no rowId
    expect(result).not.toHaveProperty("rowId");
    expect(db.writeMemory).toHaveBeenCalledOnce();
    expect(db.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-ada",
        at: fixedDate,
        kind: "session",
        sourceSession: "session-abc",
      }),
    );
    // content must be non-empty
    const callArg = db.writeMemory.mock.calls[0]![0];
    expect(typeof callArg.content).toBe("string");
    expect(callArg.content.length).toBeGreaterThan(0);
  });

  it("returns fallback and calls workspaceFallback when writeMemory throws", async () => {
    const db = makeDb(() => Promise.reject(new Error("pg down")));
    const workspaceFallback = vi
      .fn<(profileId: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const input = makeInput({ assistantTurns: ["Turn content."] });
    const result = await flushSessionMemory(input, { db, workspaceFallback });
    expect(result.status).toBe("fallback");
    expect(workspaceFallback).toHaveBeenCalledOnce();
    expect(workspaceFallback).toHaveBeenCalledWith("profile-ada", expect.any(String));
  });

  it("returns failed without throwing when both writeMemory and workspaceFallback throw", async () => {
    const db = makeDb(() => Promise.reject(new Error("pg down")));
    const workspaceFallback = vi
      .fn<(profileId: string, content: string) => Promise<void>>()
      .mockRejectedValue(new Error("workspace write failed"));
    const input = makeInput({ assistantTurns: ["Turn content."] });
    const result = await flushSessionMemory(input, { db, workspaceFallback });
    expect(result.status).toBe("failed");
    // Must not throw
  });

  it("calls custom summarize with the full turn array", async () => {
    const db = makeDb();
    const turns = ["turn A", "turn B", "turn C"];
    const summarize = vi
      .fn<(turns: readonly string[]) => string>()
      .mockReturnValue("custom summary");
    await flushSessionMemory(makeInput({ assistantTurns: turns }), { db, summarize });
    expect(summarize).toHaveBeenCalledWith(turns);
  });

  it("uses injected now() for the at column", async () => {
    const db = makeDb();
    const fixedDate = new Date("2026-01-01T00:00:00Z");
    await flushSessionMemory(makeInput({ assistantTurns: ["some content"] }), {
      db,
      now: () => fixedDate,
    });
    expect(db.writeMemory).toHaveBeenCalledWith(expect.objectContaining({ at: fixedDate }));
  });

  it("returns fallback when writeMemory rejects with a timeout (hung query)", async () => {
    // Simulate a writeMemory that rejects (mimicking the timeout race in db.ts).
    const db = makeDb(() =>
      Promise.reject(new Error("henry-context: writeMemory query timed out")),
    );
    const workspaceFallback = vi
      .fn<(profileId: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const result: FlushResult = await flushSessionMemory(
      makeInput({ assistantTurns: ["Turn content."] }),
      { db, workspaceFallback },
    );
    expect(result.status).toBe("fallback");
    expect(workspaceFallback).toHaveBeenCalledOnce();
  });
});
