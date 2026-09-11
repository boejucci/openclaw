import type { PluginHookAgentContext, PluginHookAgentEndEvent } from "openclaw/plugin-sdk/types";
import type { HenryContextDb } from "./db.ts";
import { flushSessionMemory } from "./memory-flush.ts";

// ── Default heuristic summarizer ──────────────────────────────────────────────

function defaultSummarize(turns: readonly string[]): string {
  const maxPerTurn = 600;
  const maxTotal = 1800;
  const excerpts = turns.slice(-3).map((t) => t.slice(0, maxPerTurn).trimEnd());
  const joined = excerpts.join("\n---\n");
  return joined.slice(0, maxTotal);
}

// ── Public interface ──────────────────────────────────────────────────────────

export function createEndHook(params: {
  db: Pick<HenryContextDb, "writeMemory">;
  workspaceFallback: (profileId: string, content: string) => Promise<void>;
  flushEnabled: boolean;
  /**
   * Returns the content of the person's most recent memory item, or null if
   * none exists. Used for deduplication: if the would-be summary equals this
   * value, the flush is skipped.
   */
  getLastMemoryContent: (profileId: string) => Promise<string | null>;
  logger: {
    info?: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}): (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> {
  const { db, workspaceFallback, flushEnabled, getLastMemoryContent, logger } = params;

  return async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
    // senderId and sessionKey live on ctx, not on event.
    // PluginHookAgentEndEvent only has: runId?, messages, success, error?, durationMs?
    const senderId = ctx.senderId;
    const sessionKey = ctx.sessionKey;

    // Early return conditions
    if (!flushEnabled || !senderId || !sessionKey) {
      return;
    }

    const profileId = senderId;

    // Extract assistant turns: string content only, last 6 at most.
    // SDK emits messages as unknown[] — guard each element at runtime.
    const allAssistantTurns = (event.messages ?? [])
      .filter(
        (m): m is { role: string; content: string } =>
          typeof m === "object" &&
          m !== null &&
          "role" in m &&
          (m as Record<string, unknown>).role === "assistant" &&
          typeof (m as Record<string, unknown>).content === "string",
      )
      .map((m) => m.content);
    const assistantTurns = allAssistantTurns.slice(-6);

    // Deduplicate before flushing: compare would-be summary to last stored item.
    // Note: dedup always uses defaultSummarize here regardless of the summarize
    // override passed to flushSessionMemory below. This is safe in the current
    // wiring (register.ts also passes summarize: defaultSummarize) but would
    // diverge if a custom summarizer were injected — a known limitation (SF-P5-4).
    try {
      const candidateSummary = defaultSummarize(assistantTurns);
      if (candidateSummary.trim().length > 0) {
        const lastContent = await getLastMemoryContent(profileId);
        if (lastContent !== null && lastContent === candidateSummary) {
          logger.info?.(
            `[henry-context] agent_end: skipped flush for session ${sessionKey} (duplicate)`,
          );
          return;
        }
      }
    } catch {
      // If dedup check fails, proceed with the flush — better to write than silently skip
    }

    // Flush
    try {
      const result = await flushSessionMemory(
        { profileId, sessionKey, assistantTurns },
        { db, workspaceFallback, summarize: defaultSummarize },
      );

      if (result.status === "wrote") {
        logger.info?.(`[henry-context] agent_end: wrote memory for session ${sessionKey}`);
      } else if (result.status === "skipped") {
        logger.info?.(`[henry-context] agent_end: skipped flush — ${result.reason}`);
      } else if (result.status === "fallback") {
        logger.warn(`[henry-context] agent_end: Postgres write failed; fell back to MEMORY.md`);
      } else if (result.status === "failed") {
        // Privacy: error-level logs must not contain content or profileId
        logger.error(`[henry-context] agent_end: memory flush failed for session ${sessionKey}`);
      }
    } catch {
      // Never throw — the hook must not propagate errors
      logger.error(`[henry-context] agent_end: unexpected error during flush`);
    }
  };
}
