import { z } from "zod";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec", "store"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

const henryPolicyConfigSchema = z
  .object({
    db: z
      .object({
        dsn: secretInputSchema,
        poolMax: z.number().int().min(1).max(10).default(2),
      })
      .strict(),
    cacheTtlSeconds: z.number().int().min(0).max(600).default(60),
    defaultVerdict: z.enum(["allow", "deny"]).default("deny"),
    passthroughNoPrincipal: z.boolean().default(true),
  })
  .strict();

export type HenryPolicySecretInput = z.infer<typeof secretInputSchema>;

export type ResolvedHenryPolicyConfig = {
  db: {
    dsn: HenryPolicySecretInput;
    poolMax: number;
  };
  cacheTtlSeconds: number;
  defaultVerdict: "allow" | "deny";
  passthroughNoPrincipal: boolean;
};

const CONFIG_PATH_PREFIX = "plugins.entries.henry-policy.config";

export function resolveHenryPolicyConfig(params: {
  pluginConfig: unknown;
}): ResolvedHenryPolicyConfig {
  const result = henryPolicyConfigSchema.safeParse(params.pluginConfig);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.length
      ? `${CONFIG_PATH_PREFIX}.${first.path.join(".")}`
      : CONFIG_PATH_PREFIX;
    throw new Error(`${path}: ${first?.message ?? result.error.message}`);
  }
  return result.data;
}
