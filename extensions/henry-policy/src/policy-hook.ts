// MCP tools reach before_tool_call as `<serverName>__<toolName>` because
// TOOL_NAME_SEPARATOR = "__" (src/agents/agent-bundle-mcp-names.ts:10).
// The access DSL uses `mcp:<server>:<tool>`, so we normalize before matching.
// Longest-prefix wins to handle servers whose names contain "__" (e.g. "mon__day").
import { evaluateAccess, parseAccessPolicy } from "./access.js";
import type { AccessPolicy } from "./access.js";
import type { HenryDb } from "./db.js";
import { matchGlob } from "./glob.js";
import type { DecisionLogger } from "./logger.js";

export type PolicyHookParams = {
  db: HenryDb;
  logger: DecisionLogger;
  globalDefaultVerdict: "allow" | "deny";
  passthroughNoPrincipal: boolean;
  mcpServerNameMap: ReadonlyMap<string, string>;
};

export function normalizeToolName(
  toolName: string,
  mcpServerNameMap: ReadonlyMap<string, string>,
): string {
  if (mcpServerNameMap.size === 0) {
    return toolName;
  }

  // Find the longest safe server name that is a valid prefix of toolName via `<safeName>__`.
  // Longest-prefix wins to handle servers whose names contain "__" (e.g. "mon__day").
  let bestSafe: string | undefined;
  for (const safeName of mcpServerNameMap.keys()) {
    const prefix = `${safeName}__`;
    if (toolName.startsWith(prefix)) {
      if (bestSafe === undefined || safeName.length > bestSafe.length) {
        bestSafe = safeName;
      }
    }
  }

  if (bestSafe === undefined) {
    return toolName;
  }

  const configKey = mcpServerNameMap.get(bestSafe)!;
  const rest = toolName.slice(bestSafe.length + "__".length); // strip "<bestSafe>__"
  return `mcp:${configKey}:${rest}`;
}

function resolveMatchedGlob(policy: AccessPolicy, normalizedName: string): string {
  for (const rule of policy.rules) {
    if (matchGlob(rule.glob, normalizedName)) {
      return rule.glob;
    }
  }
  return "default";
}

function shortParamSummary(params: Record<string, unknown>): string {
  try {
    // Tokens shorter than 40 chars pass unredacted; intentional for ISI's controlled 4-person deployment.
    const raw = JSON.stringify(params).replace(/[A-Za-z0-9+/]{40,}/g, "[redacted]");
    return raw.slice(0, 200);
  } catch {
    return "(unavailable)";
  }
}

export function createPolicyHook(params: PolicyHookParams) {
  const { db, logger, globalDefaultVerdict, passthroughNoPrincipal, mcpServerNameMap } = params;

  return async function policyHook(
    event: { toolName: string; params: Record<string, unknown> },
    ctx: { requester?: { senderId?: string }; abortSignal?: AbortSignal },
  ): Promise<
    | undefined
    | { block: true; blockReason: string }
    | {
        requireApproval: {
          title: string;
          description: string;
          severity: "warning";
          timeoutMs: number;
          allowedDecisions: Array<"allow-once" | "deny">;
          onResolution: (decision: string) => Promise<void>;
        };
      }
  > {
    const senderId = ctx.requester?.senderId;

    if (!senderId) {
      if (passthroughNoPrincipal) {
        return undefined;
      }
      logger.log({
        profileId: null,
        tool: event.toolName,
        params: event.params,
        verdict: "block_no_principal",
        reason: "no_principal",
      });
      return {
        block: true,
        blockReason:
          "No requester identity. Automated runs are not permitted when passthroughNoPrincipal is disabled.",
      };
    }

    let person;
    try {
      person = await db.getPerson(senderId);
    } catch {
      // DB error — fail closed; do not log (this is an infrastructure failure, not a policy decision)
      return { block: true, blockReason: "Policy check unavailable. Try again shortly." };
    }

    if (person === null) {
      logger.log({
        profileId: senderId,
        tool: event.toolName,
        params: event.params,
        verdict: "block_not_provisioned",
        reason: "not_provisioned",
      });
      return {
        block: true,
        blockReason: "You're not provisioned in Henry. Ask Joe to add you.",
      };
    }

    const policy = parseAccessPolicy(person.access, globalDefaultVerdict);
    const normalizedName = normalizeToolName(event.toolName, mcpServerNameMap);
    const verdict = evaluateAccess(policy, normalizedName);
    const matchedGlobStr = resolveMatchedGlob(policy, normalizedName);

    if (verdict === "allow") {
      logger.log({
        profileId: senderId,
        tool: normalizedName,
        params: event.params,
        verdict: "allow",
        reason: matchedGlobStr,
      });
      return undefined;
    }

    if (verdict === "deny") {
      logger.log({
        profileId: senderId,
        tool: normalizedName,
        params: event.params,
        verdict: "deny",
        reason: matchedGlobStr,
      });
      return {
        block: true,
        blockReason: `${event.toolName} is not available for your access level. To take this action, draft exactly what you want to do — the tool, the parameters, and why — and ask Joe to run it.`,
      };
    }

    // verdict === "approval"
    const summary = shortParamSummary(event.params);
    const displayName = person.displayName ?? person.email;

    logger.log({
      profileId: senderId,
      tool: normalizedName,
      params: event.params,
      verdict: "approval",
      reason: matchedGlobStr,
    });

    return {
      requireApproval: {
        title: `Approve: ${event.toolName}`,
        description: `${displayName} wants to run ${event.toolName}.\n\nMatched rule: ${matchedGlobStr}\n\nParams (summary): ${summary}`,
        severity: "warning",
        timeoutMs: 300_000,
        allowedDecisions: ["allow-once", "deny"],
        onResolution: async (decision: string) => {
          logger.log({
            profileId: senderId,
            tool: normalizedName,
            params: event.params,
            verdict: decision === "allow-once" ? "allow" : "deny",
            reason: `approval:${decision}`,
          });
        },
      },
    };
  };
}
