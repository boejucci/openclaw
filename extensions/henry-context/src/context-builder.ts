export type ContextTiers = {
  teamContent?: string;
  speaker?: {
    displayName: string;
    role: string;
    contextMd: string;
    memory: Array<{ at: Date; content: string }>;
  };
};

export type AssembledContext = {
  text: string;
  truncated: boolean;
};

/** Rough token count: chars / 4, rounded up. */
export function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text at the last complete line boundary that fits within the token
 * budget. Returns the (possibly truncated) text and whether truncation occurred.
 */
function truncateAtLineBoundary(
  text: string,
  tokenBudget: number,
): { result: string; wasTruncated: boolean } {
  if (roughTokenCount(text) <= tokenBudget) {
    return { result: text, wasTruncated: false };
  }
  const lines = text.split("\n");
  let accumulated = "";
  let last = "";
  for (const line of lines) {
    const candidate = accumulated.length === 0 ? line : accumulated + "\n" + line;
    if (roughTokenCount(candidate) <= tokenBudget) {
      last = candidate;
      accumulated = candidate;
    } else {
      break;
    }
  }
  return { result: last + (last.length > 0 ? "\n[truncated]" : "[truncated]"), wasTruncated: true };
}

/**
 * Assemble the injection block. Truncates deterministically to stay within
 * the combined token budget. Never throws.
 */
export function assembleContextBlock(
  tiers: ContextTiers,
  opts: {
    teamTokenBudget?: number;
    speakerTokenBudget?: number;
  },
): AssembledContext {
  const teamTokenBudget = opts.teamTokenBudget ?? 2000;
  const speakerTokenBudget = opts.speakerTokenBudget ?? 1000;

  const hasTeam = tiers.teamContent !== undefined;
  const hasSpeaker = tiers.speaker !== undefined;

  if (!hasTeam && !hasSpeaker) {
    return { text: "", truncated: false };
  }

  let truncated = false;
  const parts: string[] = [];

  parts.push("--- Henry Context ---");

  // Team section
  if (hasTeam) {
    parts.push("## Team");
    const teamText = tiers.teamContent as string;
    const { result, wasTruncated } = truncateAtLineBoundary(teamText, teamTokenBudget);
    parts.push(result);
    if (wasTruncated) {
      truncated = true;
    }
    parts.push("");
  }

  // Speaker section
  if (hasSpeaker) {
    const speaker = tiers.speaker as NonNullable<ContextTiers["speaker"]>;

    parts.push("## You");
    parts.push(`Name: ${speaker.displayName}`);
    parts.push(`Role: ${speaker.role}`);

    // Determine how many tokens the header lines (name + role) consume.
    // contextMd and memory must fit within the speaker budget.
    const headerTokens = roughTokenCount(`Name: ${speaker.displayName}\nRole: ${speaker.role}\n`);
    const remainingBudget = Math.max(0, speakerTokenBudget - headerTokens);

    // Truncate memory items oldest-first until contextMd + memory fit the budget.
    // Memory is provided most-recent-first per the spec (caller orders them); we
    // drop from the end (oldest) first.
    const memoryItems = [...speaker.memory];

    const contextMdTokens = roughTokenCount(speaker.contextMd);

    // Drop oldest items (end of array) until everything fits.
    while (memoryItems.length > 0) {
      const memoryText = memoryItems.map((m) => `- ${m.content}`).join("\n");
      const memoryTokens = roughTokenCount(memoryText);
      if (contextMdTokens + memoryTokens <= remainingBudget) {
        break;
      }
      memoryItems.pop();
      truncated = true;
    }

    // Truncate contextMd at line boundary if it alone exceeds the remaining budget.
    // Name and role always survive; contextMd is the last resort before the budget
    // is exceeded. Memory has already been dropped above.
    if (speaker.contextMd.length > 0) {
      const memoryTokensNow =
        memoryItems.length > 0
          ? roughTokenCount(memoryItems.map((m) => `- ${m.content}`).join("\n"))
          : 0;
      const contextBudget = Math.max(0, remainingBudget - memoryTokensNow);
      const { result: contextResult, wasTruncated: contextTruncated } = truncateAtLineBoundary(
        speaker.contextMd,
        contextBudget,
      );
      if (contextTruncated) {
        truncated = true;
      }
      parts.push(contextResult);
    }

    if (memoryItems.length > 0) {
      parts.push("");
      parts.push("## Your recent memory");
      parts.push(memoryItems.map((m) => `- ${m.content}`).join("\n"));
    }
  }

  parts.push("--- End Henry Context ---");

  return { text: parts.join("\n"), truncated };
}
