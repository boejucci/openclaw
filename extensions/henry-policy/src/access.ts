import { z } from "zod";
import { matchGlob } from "./glob.js";

export type AccessVerdict = "allow" | "deny" | "approval";

export type AccessRule = {
  glob: string;
  verdict: AccessVerdict;
};

export type AccessPolicy = {
  defaultVerdict: "allow" | "deny";
  rules: readonly AccessRule[];
};

const accessRuleSchema = z.object({
  glob: z.string().min(1),
  verdict: z.enum(["allow", "deny", "approval"]),
});

const accessPolicySchema = z.object({
  defaultVerdict: z.enum(["allow", "deny"]).optional(),
  rules: z.array(z.unknown()).optional(),
});

export function parseAccessPolicy(raw: unknown, globalDefault: "allow" | "deny"): AccessPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { defaultVerdict: globalDefault, rules: [] };
  }

  const top = accessPolicySchema.catch({ defaultVerdict: undefined, rules: [] }).parse(raw);

  const defaultVerdict: "allow" | "deny" = top.defaultVerdict ?? globalDefault;

  const rules: AccessRule[] = [];
  for (const entry of top.rules ?? []) {
    const parsed = accessRuleSchema.safeParse(entry);
    if (parsed.success) {
      rules.push(parsed.data);
    }
  }

  return { defaultVerdict, rules };
}

export function evaluateAccess(policy: AccessPolicy, toolName: string): AccessVerdict {
  for (const rule of policy.rules) {
    if (matchGlob(rule.glob, toolName)) {
      return rule.verdict;
    }
  }
  return policy.defaultVerdict;
}
