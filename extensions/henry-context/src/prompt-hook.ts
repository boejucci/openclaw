import { assembleContextBlock } from "./context-builder.ts";
import type { CachedContextDb } from "./db.ts";

export function createPromptHook(params: {
  db: CachedContextDb;
  teamTokenBudget: number;
  speakerTokenBudget: number;
  memoryItemLimit: number;
}): (
  event: { prompt: string },
  ctx: { senderId?: string },
) => Promise<{ prependSystemContext?: string } | undefined> {
  const { db, teamTokenBudget, speakerTokenBudget, memoryItemLimit } = params;

  return async (
    _event: { prompt: string },
    ctx: { senderId?: string },
  ): Promise<{ prependSystemContext?: string } | undefined> => {
    let teamContent: string | undefined;
    let speaker:
      | {
          displayName: string;
          role: string;
          contextMd: string;
          memory: Array<{ at: Date; content: string }>;
        }
      | undefined;

    // Tier A: team context — always attempted
    try {
      const team = await db.getTeamContext();
      if (team !== null) {
        teamContent = team.contentMd;
      }
    } catch {
      // Any error → tier A absent
    }

    // Tier B: speaker context — only when senderId is present
    if (ctx.senderId !== undefined) {
      try {
        const person = await db.getPerson(ctx.senderId);
        if (person !== null) {
          const memory = await db.getMemory(ctx.senderId, memoryItemLimit);
          speaker = {
            displayName: person.displayName,
            role: person.role,
            contextMd: person.contextMd,
            memory: memory.map((m) => ({ at: m.at, content: m.content })),
          };
        }
        // person null → tier B absent; tier A still emitted
      } catch {
        // getPerson throws → return team context only (tier B absent)
      }
    }

    const { text } = assembleContextBlock(
      { teamContent, speaker },
      { teamTokenBudget, speakerTokenBudget },
    );

    if (text.length === 0) {
      return undefined;
    }

    return { prependSystemContext: text };
  };
}
