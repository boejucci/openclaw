import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type PolicyVerdict =
  | "allow"
  | "deny"
  | "approval"
  | "block_no_principal"
  | "block_not_provisioned";

export type DecisionLogEntry = {
  profileId: string | null;
  tool: string;
  params: unknown;
  verdict: PolicyVerdict;
  reason: string;
};

export type DecisionLogger = {
  log(entry: DecisionLogEntry): void;
};

export function createDecisionLogger(params: { pool: Pool; enabled?: boolean }): DecisionLogger {
  const { pool, enabled = true } = params;

  return {
    log(entry: DecisionLogEntry): void {
      if (!enabled) return;

      const digest = digestParams(entry.params);

      queueMicrotask(() => {
        void pool
          .query(
            "INSERT INTO henry_policy_decisions (profile_id, tool, params_digest, verdict, reason) VALUES ($1, $2, $3, $4, $5)",
            [entry.profileId, entry.tool, digest, entry.verdict, entry.reason],
          )
          .catch(() => {
            console.warn(
              `[henry-policy] decision log write failed for tool=${entry.tool} verdict=${entry.verdict}`,
            );
          });
      });
    },
  };
}

export function digestParams(params: unknown): string {
  try {
    const serialized = JSON.stringify(params) ?? "";
    return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  } catch {
    return "0000000000000000";
  }
}
