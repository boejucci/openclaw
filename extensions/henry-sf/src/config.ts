// Henry-sf helper module resolves per-person Salesforce CLI config.
import { z } from "zod";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec", "store"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

const personSchema = z
  .object({
    username: z.string().trim().min(1),
    role: z.enum(["admin", "member"]),
    org: z.string().trim().min(1).optional(),
  })
  .strict();

const orgSchema = z
  .object({
    instanceUrl: z.url(),
    loginUrl: z.url().default("https://login.salesforce.com"),
    clientId: z.string().trim().min(1),
    jwtKey: secretInputSchema,
    default: z.boolean().default(false),
  })
  .strict();

const henrySfConfigSchema = z
  .object({
    people: z.record(z.string().trim().min(1), personSchema).default({}),
    orgs: z.record(z.string().trim().min(1), orgSchema).default({}),
    // .prefault, not .default: zod substitutes a plain .default() value verbatim
    // without re-running it through the wrapped schema, so an absent `route` key
    // would otherwise skip `path`'s own default instead of resolving to it.
    route: z
      .object({ path: z.string().trim().min(1).default("/henry/sf/credential") })
      .strict()
      .prefault({}),
    credentialUrl: z.url().optional(),
    runTokenTtlSeconds: z.number().int().min(60).max(3600).default(900),
    credentialCacheSeconds: z.number().int().min(0).max(7200).default(1800),
  })
  .strict();

export type HenrySfRole = z.infer<typeof personSchema>["role"];
export type HenrySfSecretInput = z.infer<typeof secretInputSchema>;

export type HenrySfPerson = {
  profileId: string;
  username: string;
  role: HenrySfRole;
  orgKey: string;
};

export type HenrySfOrg = {
  key: string;
  instanceUrl: string;
  loginUrl: string;
  clientId: string;
  jwtKey: HenrySfSecretInput;
};

export type ResolvedHenrySfConfig = {
  people: ReadonlyMap<string, HenrySfPerson>;
  orgs: ReadonlyMap<string, HenrySfOrg>;
  routePath: string;
  credentialUrl?: string;
  runTokenTtlSeconds: number;
  credentialCacheSeconds: number;
};

const CONFIG_PATH_PREFIX = "plugins.entries.henry-sf.config";

function stripOneTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function resolvePersonOrgKey(params: {
  profileId: string;
  org: string | undefined;
  orgKeys: ReadonlySet<string>;
  defaultOrgKeys: readonly string[];
}): string {
  const { profileId, org, orgKeys, defaultOrgKeys } = params;
  if (org !== undefined) {
    if (!orgKeys.has(org)) {
      throw new Error(
        `${CONFIG_PATH_PREFIX}.people.${profileId}.org references unknown org "${org}"`,
      );
    }
    return org;
  }

  const defaultOrgKey = defaultOrgKeys.length === 1 ? defaultOrgKeys[0] : undefined;
  if (defaultOrgKey === undefined) {
    throw new Error(
      `${CONFIG_PATH_PREFIX}.orgs must mark exactly one org as default because ` +
        `${CONFIG_PATH_PREFIX}.people.${profileId}.org is omitted (found ${defaultOrgKeys.length} default orgs)`,
    );
  }
  return defaultOrgKey;
}

export function resolveHenrySfConfig(params: { pluginConfig: unknown }): ResolvedHenrySfConfig {
  const parsed = henrySfConfigSchema.parse(params.pluginConfig ?? {});
  const orgKeys = new Set(Object.keys(parsed.orgs));
  const defaultOrgKeys = Object.entries(parsed.orgs)
    .filter(([, org]) => org.default)
    .map(([key]) => key);

  const people = new Map<string, HenrySfPerson>(
    Object.entries(parsed.people).map(([profileId, person]) => [
      profileId,
      {
        profileId,
        username: person.username,
        role: person.role,
        orgKey: resolvePersonOrgKey({ profileId, org: person.org, orgKeys, defaultOrgKeys }),
      },
    ]),
  );

  const orgs = new Map<string, HenrySfOrg>(
    Object.entries(parsed.orgs).map(([key, org]) => [
      key,
      {
        key,
        instanceUrl: stripOneTrailingSlash(org.instanceUrl),
        loginUrl: stripOneTrailingSlash(org.loginUrl),
        clientId: org.clientId,
        jwtKey: org.jwtKey,
      },
    ]),
  );

  return {
    people,
    orgs,
    routePath: parsed.route.path,
    ...(parsed.credentialUrl !== undefined ? { credentialUrl: parsed.credentialUrl } : {}),
    runTokenTtlSeconds: parsed.runTokenTtlSeconds,
    credentialCacheSeconds: parsed.credentialCacheSeconds,
  };
}

export function findPerson(
  config: ResolvedHenrySfConfig,
  senderId: string | undefined,
): HenrySfPerson | undefined {
  return senderId ? config.people.get(senderId) : undefined;
}
