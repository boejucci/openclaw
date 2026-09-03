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

      // Stored synchronously with no expiry while in flight so concurrent callers
      // single-flight onto this promise even when caching is disabled; the settle
      // handlers below then drop the entry (cache off, or a failure) or leave it
      // until the cache window ends.
      const promise = mintForPerson(person);
      const entry: CacheEntry = {
        promise,
        expiresAtMs: cacheMs > 0 ? now() + cacheMs : Number.POSITIVE_INFINITY,
      };
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
