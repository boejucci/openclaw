import type { HenrySfOrg, HenrySfPerson, HenrySfRole, ResolvedHenrySfConfig } from "./config.js";
import { mintSalesforceAccessToken, type MintedCredential } from "./sf-jwt.js";

export type PersonCredential = MintedCredential & {
  username: string;
  role: HenrySfRole;
  orgKey: string;
};

export type CredentialService = {
  forPerson(person: HenrySfPerson): Promise<PersonCredential>;
};

type CacheEntry = { promise: Promise<PersonCredential>; expiresAtMs: number };

export function createCredentialService(params: {
  config: ResolvedHenrySfConfig;
  resolveJwtKey: (org: HenrySfOrg) => Promise<string>;
  mint?: typeof mintSalesforceAccessToken;
  now?: () => number;
}): CredentialService {
  const mint = params.mint ?? mintSalesforceAccessToken;
  const now = params.now ?? Date.now;
  const cacheMs = params.config.credentialCacheSeconds * 1000;
  const cache = new Map<string, CacheEntry>();

  async function mintForPerson(person: HenrySfPerson): Promise<PersonCredential> {
    const org = params.config.orgs.get(person.orgKey);
    if (!org) {
      throw new Error(
        `henry-sf: unknown Salesforce org "${person.orgKey}" for "${person.profileId}"`,
      );
    }
    const privateKeyPem = await params.resolveJwtKey(org);
    const minted = await mint({
      loginUrl: org.loginUrl,
      clientId: org.clientId,
      username: person.username,
      privateKeyPem,
      now,
    });
    return { ...minted, username: person.username, role: person.role, orgKey: person.orgKey };
  }

  return {
    forPerson(person) {
      const key = `${person.orgKey}:${person.username}`;
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAtMs) {
        return cached.promise;
      }

      // Stored synchronously (before the mint settles) so truly concurrent callers
      // single-flight onto this same promise even when cacheMs is 0; the settle
      // handlers below then decide whether the entry survives past this call.
      const promise = mintForPerson(person);
      const entry: CacheEntry = { promise, expiresAtMs: now() + cacheMs };
      cache.set(key, entry);
      promise.then(
        () => {
          if (cacheMs <= 0 && cache.get(key) === entry) {
            cache.delete(key);
          }
        },
        () => {
          if (cache.get(key) === entry) {
            cache.delete(key);
          }
        },
      );
      return promise;
    },
  };
}
