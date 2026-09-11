// MCP tools reach before_tool_call as `<serverName>__<toolName>` because
// TOOL_NAME_SEPARATOR = "__" (src/agents/agent-bundle-mcp-names.ts:10).
// The access DSL uses `mcp:<server>:<tool>`, so we normalize before matching.
// Longest-prefix wins to handle servers whose names contain "__" (e.g. "mon__day").
import { evaluateAccessWithReason, parseAccessPolicy } from "./access.js";
import type { AccessPolicy, AccessVerdict } from "./access.js";
import type { HenryDb } from "./db.js";
import { classifyExecCommand } from "./exec-classifier.js";
import type { DecisionLogger } from "./logger.js";

export type PolicyHookParams = {
  db: HenryDb;
  logger: DecisionLogger;
  globalDefaultVerdict: "allow" | "deny";
  passthroughNoPrincipal: boolean;
  mcpServerNameMap: ReadonlyMap<string, string>;
  /**
   * Called (rate-limited by the caller) when db.getPerson throws so that
   * fail-closed blocks surface in the journal on first occurrence.
   * Optional — if absent no extra warn is emitted beyond the fail-closed block.
   */
  warnDbFailure?: (message: string) => void;
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

/**
 * Resolve the effective verdict and matched-glob string for a tool call,
 * applying exec-classifier logic when the tool is "exec".
 *
 * When the tool name is "exec" and the command is a string:
 *   1. Classify the command as "pure-sf" or "generic".
 *   2. For "pure-sf", evaluate the pseudo-tool "exec:sf" against the policy.
 *      - If a rule matched (ruleMatched: true), use that verdict and log "exec:sf".
 *      - If only the default would apply, fall through to plain "exec" evaluation
 *        so configs without an exec:sf rule behave exactly as before.
 *   3. For "generic" (or non-string command), evaluate plain "exec".
 *
 * For all other tools, evaluate normally.
 */
function resolveExecAwareVerdict(
  policy: AccessPolicy,
  normalizedName: string,
  params: Record<string, unknown>,
): { verdict: AccessVerdict; loggedTool: string; matchedGlobStr: string } {
  if (normalizedName === "exec" && typeof params.command === "string") {
    const commandClass = classifyExecCommand(params.command);
    if (commandClass === "pure-sf") {
      const sfResult = evaluateAccessWithReason(policy, "exec:sf");
      if (sfResult.ruleMatched) {
        return {
          verdict: sfResult.verdict,
          loggedTool: "exec:sf",
          matchedGlobStr: sfResult.matchedGlob,
        };
      }
      // No exec:sf rule — fall through to plain exec evaluation below.
    }
  }
  // Plain exec evaluation (or non-exec tools).
  const result = evaluateAccessWithReason(policy, normalizedName);
  return {
    verdict: result.verdict,
    loggedTool: normalizedName,
    matchedGlobStr: result.matchedGlob,
  };
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
  const {
    db,
    logger,
    globalDefaultVerdict,
    passthroughNoPrincipal,
    mcpServerNameMap,
    warnDbFailure,
  } = params;

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
      warnDbFailure?.("[henry-policy] db.getPerson failed; policy check fail-closed");
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
    const { verdict, loggedTool, matchedGlobStr } = resolveExecAwareVerdict(
      policy,
      normalizedName,
      event.params,
    );

    if (verdict === "allow") {
      logger.log({
        profileId: senderId,
        tool: loggedTool,
        params: event.params,
        verdict: "allow",
        reason: matchedGlobStr,
      });
      return undefined;
    }

    if (verdict === "deny") {
      logger.log({
        profileId: senderId,
        tool: loggedTool,
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
      tool: loggedTool,
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
            tool: loggedTool,
            params: event.params,
            verdict: decision === "allow-once" ? "allow" : "deny",
            reason: `approval:${decision}`,
          });
        },
      },
    };
  };
}
