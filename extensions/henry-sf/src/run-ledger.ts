export type RunLedger = {
  markEnded(runId: string): void;
  hasEnded(runId: string): boolean;
};

// Ended runs need remembering only while their tokens could still verify,
// so entries older than the token TTL are pruned on each write.
export function createRunLedger(params: { ttlSeconds: number; now?: () => number }): RunLedger {
  const now = params.now ?? Date.now;
  const ttlMs = params.ttlSeconds * 1000;
  const endedAtMs = new Map<string, number>();

  function prune(currentMs: number): void {
    for (const [runId, endedMs] of endedAtMs) {
      if (currentMs - endedMs > ttlMs) {
        endedAtMs.delete(runId);
      }
    }
  }

  return {
    markEnded(runId) {
      const currentMs = now();
      prune(currentMs);
      endedAtMs.set(runId, currentMs);
    },
    hasEnded(runId) {
      return endedAtMs.has(runId);
    },
  };
}
