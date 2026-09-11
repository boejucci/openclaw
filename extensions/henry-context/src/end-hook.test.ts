import type { PluginHookAgentEndEvent } from "openclaw/plugin-sdk/types";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEndHook } from "./end-hook.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeWorkspaceFallback() {
  return vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined);
}

function makeWriteMemory() {
  return vi.fn<[unknown], Promise<void>>().mockResolvedValue(undefined);
}

function makeGetLastMemoryContent(value: string | null = null) {
  return vi.fn<[string], Promise<string | null>>().mockResolvedValue(value);
}

// event only contains fields from PluginHookAgentEndEvent: messages, success, runId?, error?, durationMs?
function makeEvent(overrides?: {
  messages?: unknown[];
  runId?: string;
  success?: boolean;
}): PluginHookAgentEndEvent {
  return {
    success: true,
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there, I can help with Salesforce." },
    ],
    ...overrides,
  };
}

// ctx carries senderId and sessionKey per PluginHookAgentContext
function makeCtx(overrides?: { senderId?: string; sessionKey?: string }) {
  return {
    senderId: "profile-ada",
    sessionKey: "session-abc",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createEndHook", () => {
  let writeMemory: ReturnType<typeof makeWriteMemory>;
  let workspaceFallback: ReturnType<typeof makeWorkspaceFallback>;
  let getLastMemoryContent: ReturnType<typeof makeGetLastMemoryContent>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    writeMemory = makeWriteMemory();
    workspaceFallback = makeWorkspaceFallback();
    getLastMemoryContent = makeGetLastMemoryContent(null);
    logger = makeLogger();
  });

  it("1. flushEnabled: false → writeMemory never called", async () => {
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: false,
      getLastMemoryContent,
      logger,
    });
    await hook(makeEvent(), makeCtx());
    expect(writeMemory).not.toHaveBeenCalled();
  });

  it("2. no senderId → flush skipped", async () => {
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    await hook(makeEvent(), makeCtx({ senderId: undefined }));
    expect(writeMemory).not.toHaveBeenCalled();
  });

  it("3. happy path → writeMemory called once", async () => {
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    await hook(makeEvent(), makeCtx());
    expect(writeMemory).toHaveBeenCalledOnce();
  });

  it("4. flush returns fallback → workspaceFallback called; logged at warn", async () => {
    writeMemory = vi.fn().mockRejectedValue(new Error("pg error"));
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    await hook(makeEvent(), makeCtx());
    expect(workspaceFallback).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("5. flush returns failed → logged at error; no exception", async () => {
    writeMemory = vi.fn().mockRejectedValue(new Error("pg error"));
    workspaceFallback = vi.fn().mockRejectedValue(new Error("fs error"));
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    await expect(hook(makeEvent(), makeCtx())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    // Privacy check: error message must not contain profileId
    for (const call of logger.error.mock.calls) {
      expect(call[0]).not.toContain("profile-ada");
    }
  });

  it("6. event.messages with non-assistant entries → only assistant content passed to flush", async () => {
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    const event = makeEvent({
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
        { role: "tool", content: "tool result" },
        { role: "assistant", content: "follow-up" },
      ],
    });
    await hook(event, makeCtx());
    expect(writeMemory).toHaveBeenCalledOnce();
    const row = writeMemory.mock.calls[0]?.[0] as { content: string };
    // Only assistant content in the summary
    expect(row.content).not.toContain("question");
    expect(row.content).not.toContain("tool result");
  });

  it("7. more than 6 assistant turns → only last 6 passed to flush", async () => {
    // 9 assistant turns: 0-8. Slice to last 6 gives turns 3-8.
    // The heuristic then takes slice(-3) of those 6 → turns 6-8.
    // Turns 0,1,2 are absent from the summary; turns 6,7,8 are present.
    const messages = Array.from({ length: 9 }, (_, i) => ({
      role: "assistant",
      content: `turn-${String(i)}`,
    }));
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    await hook(makeEvent({ messages }), makeCtx());
    expect(writeMemory).toHaveBeenCalledOnce();
    const row = writeMemory.mock.calls[0]?.[0] as { content: string };
    // First 3 turns must be absent (they were sliced off before passing to flush)
    expect(row.content).not.toContain("turn-0");
    expect(row.content).not.toContain("turn-1");
    expect(row.content).not.toContain("turn-2");
    // The last 3 of the last 6 (turns 6-8) appear in the heuristic summary
    expect(row.content).toContain("turn-6");
    expect(row.content).toContain("turn-7");
    expect(row.content).toContain("turn-8");
  });

  it("8. dedupe: identical to last stored item → flush skipped", async () => {
    // The default summarizer takes last 3 assistant turns (slice(-3)),
    // each up to 600 chars, joined by \n---\n, up to 1800 total.
    // We need to produce a known summary to compare against.
    const assistantContent = "The answer is 42.";
    getLastMemoryContent = makeGetLastMemoryContent(assistantContent);
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    await hook(
      makeEvent({ messages: [{ role: "assistant", content: assistantContent }] }),
      makeCtx(),
    );
    expect(writeMemory).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("9. dedupe check throws → flush still proceeds (no silent skip)", async () => {
    getLastMemoryContent = vi.fn().mockRejectedValue(new Error("db error"));
    const hook = createEndHook({
      db: { writeMemory },
      workspaceFallback,
      flushEnabled: true,
      getLastMemoryContent,
      logger,
    });
    await hook(makeEvent(), makeCtx());
    // Despite dedup check failing, flush should proceed
    expect(writeMemory).toHaveBeenCalledOnce();
  });
});
