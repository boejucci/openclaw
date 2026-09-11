import { describe, expect, it } from "vitest";
import { assembleContextBlock, roughTokenCount } from "./context-builder.js";

describe("roughTokenCount", () => {
  it("returns chars/4 rounded up — 'hello world' (11 chars) = 3", () => {
    const count = roughTokenCount("hello world");
    expect(count).toBe(3);
  });

  it("returns 0 for an empty string", () => {
    const count = roughTokenCount("");
    expect(count).toBe(0);
  });

  it("returns 1 for a single character", () => {
    const count = roughTokenCount("x");
    expect(count).toBe(1);
  });

  it("returns exact value when evenly divisible", () => {
    const count = roughTokenCount("abcd");
    expect(count).toBe(1);
  });
});

describe("assembleContextBlock", () => {
  it("1. empty tiers returns empty string, not truncated", () => {
    const result = assembleContextBlock({}, {});
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("2. team-only returns correct format, no speaker section", () => {
    const result = assembleContextBlock({ teamContent: "ISI is a cybersecurity MSP." }, {});
    expect(result.text).toContain("--- Henry Context ---");
    expect(result.text).toContain("## Team");
    expect(result.text).toContain("ISI is a cybersecurity MSP.");
    expect(result.text).toContain("--- End Henry Context ---");
    expect(result.text).not.toContain("## You");
    expect(result.text).not.toContain("## Your recent memory");
    expect(result.truncated).toBe(false);
  });

  it("3. speaker-only returns correct format, no team section", () => {
    const result = assembleContextBlock(
      {
        speaker: {
          displayName: "Ada",
          role: "admin",
          contextMd: "Preferred language: TypeScript.",
          memory: [],
        },
      },
      {},
    );
    expect(result.text).toContain("--- Henry Context ---");
    expect(result.text).toContain("## You");
    expect(result.text).toContain("Name: Ada");
    expect(result.text).toContain("Role: admin");
    expect(result.text).toContain("Preferred language: TypeScript.");
    expect(result.text).toContain("--- End Henry Context ---");
    expect(result.text).not.toContain("## Team");
    expect(result.truncated).toBe(false);
  });

  it("4. both tiers returns full block with all sections", () => {
    const result = assembleContextBlock(
      {
        teamContent: "Team background.",
        speaker: {
          displayName: "Bob",
          role: "member",
          contextMd: "Bob's context.",
          memory: [{ at: new Date("2026-09-01"), content: "Discussed roadmap." }],
        },
      },
      {},
    );
    expect(result.text).toContain("## Team");
    expect(result.text).toContain("Team background.");
    expect(result.text).toContain("## You");
    expect(result.text).toContain("Name: Bob");
    expect(result.text).toContain("Role: member");
    expect(result.text).toContain("Bob's context.");
    expect(result.text).toContain("## Your recent memory");
    expect(result.text).toContain("- Discussed roadmap.");
    expect(result.truncated).toBe(false);
  });

  it("5. oversized team truncated at correct boundary, truncated: true", () => {
    // Build a team string with many lines so it exceeds a tight budget.
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: ${"x".repeat(20)}`);
    const teamContent = lines.join("\n");

    const result = assembleContextBlock(
      { teamContent },
      { teamTokenBudget: 10 }, // very tight
    );

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated]");
    // The last line included must be a complete line from the original.
    const includedLines = lines.filter((l) => result.text.includes(l));
    expect(includedLines.length).toBeGreaterThanOrEqual(0);
    // Ensure content after [truncated] is only the footer.
    const truncIdx = result.text.indexOf("[truncated]");
    const afterTrunc = result.text.slice(truncIdx + "[truncated]".length).trim();
    expect(afterTrunc).toContain("--- End Henry Context ---");
  });

  it("6. oversized memory drops oldest items first; name and role always present", () => {
    // Create memory items (most recent first as per spec ordering).
    const memory = [
      { at: new Date("2026-09-05"), content: "newest: final task done" },
      { at: new Date("2026-09-04"), content: "middle: code review" },
      { at: new Date("2026-09-03"), content: "oldest: initial setup" },
    ];

    // Use a very tight speaker budget so only the newest item fits alongside contextMd.
    const result = assembleContextBlock(
      {
        speaker: {
          displayName: "Nikki",
          role: "member",
          contextMd: "short",
          memory,
        },
      },
      { speakerTokenBudget: 20 }, // tight enough to force dropping oldest
    );

    expect(result.text).toContain("Name: Nikki");
    expect(result.text).toContain("Role: member");
    // Oldest item should be dropped.
    expect(result.text).not.toContain("oldest: initial setup");
    // truncated flag must be set.
    expect(result.truncated).toBe(true);
  });

  it("7. speaker budget of 0 still includes name and role", () => {
    const result = assembleContextBlock(
      {
        speaker: {
          displayName: "Zero",
          role: "admin",
          contextMd: "some context that may not fit",
          memory: [{ at: new Date("2026-09-01"), content: "a memory item" }],
        },
      },
      { speakerTokenBudget: 0 },
    );

    expect(result.text).toContain("Name: Zero");
    expect(result.text).toContain("Role: admin");
  });

  it("8. roughTokenCount('hello world') = 3 (11 chars / 4 rounded up)", () => {
    const count = roughTokenCount("hello world");
    expect(count).toBe(3);
  });

  it("9. oversized contextMd is truncated at line boundary; name and role always present", () => {
    // Build a contextMd that is many lines and far exceeds a tight budget.
    const lines = Array.from({ length: 50 }, (_, i) => `Context line ${i + 1}: ${"x".repeat(30)}`);
    const contextMd = lines.join("\n");

    const result = assembleContextBlock(
      {
        speaker: {
          displayName: "Ada",
          role: "admin",
          contextMd,
          memory: [],
        },
      },
      { speakerTokenBudget: 15 }, // tight — contextMd alone far exceeds this
    );

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated]");
    expect(result.text).toContain("Name: Ada");
    expect(result.text).toContain("Role: admin");
  });
});
