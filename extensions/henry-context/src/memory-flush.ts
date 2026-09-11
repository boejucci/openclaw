/**
 * Session-end memory flush for henry-context.
 *
 * Writes a per-person memory item to Postgres at the end of a session.
 * On Postgres failure: falls back to the agent MEMORY.md workspace note.
 * On both failures: logs and returns "failed". Never throws.
 */

/** Structural type — only the write side; does not import from ./db.ts. */
type WriteMemoryDb = Pick<
  {
    writeMemory(row: {
      profileId: string;
      at: Date;
      kind: string;
      content: string;
      sourceSession?: string;
    }): Promise<void>;
  },
  "writeMemory"
>;

export type FlushInput = {
  profileId: string;
  sessionKey: string;
  /** Raw assistant turn texts from the session, most recent last. */
  assistantTurns: readonly string[];
};

export type FlushResult =
  | { status: "wrote" }
  | { status: "skipped"; reason: string }
  | { status: "fallback"; note: string } // wrote to MEMORY.md fallback
  | { status: "failed"; error: string };

export type MemoryFlushOptions = {
  db: WriteMemoryDb;
  /** Fallback writer: appends text to the agent MEMORY.md daily note. */
  workspaceFallback?: (profileId: string, content: string) => Promise<void>;
  /** Heuristic-based summarizer (v1). */
  summarize?: (turns: readonly string[]) => string;
  /** Min assistant turns to write (default 1). */
  minTurns?: number;
  /** Max chars per turn for heuristic (default 600). */
  maxCharsPerTurn?: number;
  /** Max total chars for heuristic summary (default 1800). */
  maxSummaryChars?: number;
  now?: () => Date;
};

/**
 * Default heuristic summarizer (v1): last 3 assistant turn excerpts.
 */
function defaultSummarize(turns: readonly string[], maxPerTurn: number, maxTotal: number): string {
  const excerpts = turns.slice(-3).map((t) => t.slice(0, maxPerTurn).trimEnd());
  const joined = excerpts.join("\n---\n");
  return joined.slice(0, maxTotal);
}

/**
 * Write a per-person memory item for a session. Never throws.
 * Returns a discriminated result for logging and tests.
 */
export async function flushSessionMemory(
  input: FlushInput,
  opts: MemoryFlushOptions,
): Promise<FlushResult> {
  const minTurns = opts.minTurns ?? 1;
  const maxCharsPerTurn = opts.maxCharsPerTurn ?? 600;
  const maxSummaryChars = opts.maxSummaryChars ?? 1800;
  const now = opts.now ?? (() => new Date());

  // Skip: too few turns
  if (input.assistantTurns.length < minTurns) {
    return { status: "skipped", reason: `fewer than minTurns (${minTurns})` };
  }

  // Note: deduplication (skip if summary matches the last stored item for this person)
  // is the end-hook's responsibility (wave 2, end-hook.ts), which has DB read access.

  // Produce summary
  const summarize =
    opts.summarize ?? ((turns) => defaultSummarize(turns, maxCharsPerTurn, maxSummaryChars));
  const summary = summarize(input.assistantTurns);

  // Skip: empty summary
  if (summary.trim().length === 0) {
    return { status: "skipped", reason: "summary is empty" };
  }

  // Attempt Postgres write
  try {
    await opts.db.writeMemory({
      profileId: input.profileId,
      at: now(),
      kind: "session",
      content: summary,
      sourceSession: input.sessionKey,
    });
    return { status: "wrote" };
  } catch {
    // Fallback: try workspace MEMORY.md
    if (opts.workspaceFallback !== undefined) {
      try {
        await opts.workspaceFallback(input.profileId, summary);
        return { status: "fallback", note: summary };
      } catch {
        return { status: "failed", error: "both writeMemory and workspaceFallback threw" };
      }
    }
    return { status: "failed", error: "writeMemory threw and no workspaceFallback provided" };
  }
}
