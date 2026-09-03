import { describe, expect, it } from "vitest";
import { createRunLedger } from "./run-ledger.js";

describe("createRunLedger", () => {
  it("remembers ended runs and knows nothing about the rest", () => {
    const ledger = createRunLedger({ ttlSeconds: 900, now: () => 0 });
    ledger.markEnded("run-1");
    expect(ledger.hasEnded("run-1")).toBe(true);
    expect(ledger.hasEnded("run-2")).toBe(false);
  });

  it("forgets ended runs once their tokens could no longer verify", () => {
    let nowMs = 0;
    const ledger = createRunLedger({ ttlSeconds: 900, now: () => nowMs });
    ledger.markEnded("run-1");
    nowMs = 900_000;
    ledger.markEnded("run-2");
    expect(ledger.hasEnded("run-1")).toBe(true);
    nowMs = 900_001;
    ledger.markEnded("run-3");
    expect(ledger.hasEnded("run-1")).toBe(false);
    expect(ledger.hasEnded("run-2")).toBe(true);
  });
});
