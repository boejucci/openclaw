import { describe, expect, it, vi } from "vitest";
import type { HenrySfOrg, HenrySfPerson, ResolvedHenrySfConfig } from "./config.js";
import { createCredentialService } from "./credential-service.js";
import { mintSalesforceAccessToken, type MintedCredential } from "./sf-jwt.js";

const org: HenrySfOrg = {
  key: "primary",
  instanceUrl: "https://isi.my.salesforce.com",
  loginUrl: "https://login.salesforce.com",
  clientId: "consumer-key",
  jwtKey: "unused-in-these-tests",
};

const person: HenrySfPerson = {
  profileId: "profile-ada",
  username: "ada@isi.example",
  role: "member",
  orgKey: "primary",
};

function buildConfig(overrides: Partial<ResolvedHenrySfConfig> = {}): ResolvedHenrySfConfig {
  return {
    people: new Map([[person.profileId, person]]),
    orgs: new Map([[org.key, org]]),
    routePath: "/henry/sf/credential",
    runTokenTtlSeconds: 900,
    credentialCacheSeconds: 1800,
    ...overrides,
  };
}

function fixedCredential(): MintedCredential {
  return { accessToken: "access-token", instanceUrl: org.instanceUrl, issuedAtMs: 0 };
}

describe("createCredentialService", () => {
  it("mints once for two sequential calls to the same person", async () => {
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const resolveJwtKey = vi.fn<(org: HenrySfOrg) => Promise<string>>().mockResolvedValue("pem");
    const service = createCredentialService({
      config: buildConfig(),
      resolveJwtKey,
      mint,
      now: () => 0,
    });

    await service.forPerson(person);
    await service.forPerson(person);

    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("single-flights two concurrent calls to the same person", async () => {
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const resolveJwtKey = vi.fn<(org: HenrySfOrg) => Promise<string>>().mockResolvedValue("pem");
    const service = createCredentialService({
      config: buildConfig(),
      resolveJwtKey,
      mint,
      now: () => 0,
    });

    const [first, second] = await Promise.all([
      service.forPerson(person),
      service.forPerson(person),
    ]);

    expect(mint).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("mints again once the cache window has passed", async () => {
    let currentMs = 0;
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const resolveJwtKey = vi.fn<(org: HenrySfOrg) => Promise<string>>().mockResolvedValue("pem");
    const service = createCredentialService({
      config: buildConfig({ credentialCacheSeconds: 60 }),
      resolveJwtKey,
      mint,
      now: () => currentMs,
    });

    await service.forPerson(person);
    currentMs = 60_000;
    await service.forPerson(person);

    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected mint, so the next call mints again", async () => {
    const mint = vi
      .fn<typeof mintSalesforceAccessToken>()
      .mockRejectedValueOnce(new Error("mint failed"))
      .mockResolvedValue(fixedCredential());
    const resolveJwtKey = vi.fn<(org: HenrySfOrg) => Promise<string>>().mockResolvedValue("pem");
    const service = createCredentialService({
      config: buildConfig(),
      resolveJwtKey,
      mint,
      now: () => 0,
    });

    await expect(service.forPerson(person)).rejects.toThrow("mint failed");
    await expect(service.forPerson(person)).resolves.toMatchObject({ accessToken: "access-token" });

    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("resolves the JWT key for the person's org and passes it through as privateKeyPem", async () => {
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const resolveJwtKey = vi
      .fn<(org: HenrySfOrg) => Promise<string>>()
      .mockResolvedValue("the-pem-key");
    const config = buildConfig();
    const service = createCredentialService({ config, resolveJwtKey, mint, now: () => 0 });

    const credential = await service.forPerson(person);

    expect(resolveJwtKey).toHaveBeenCalledWith(org);
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ privateKeyPem: "the-pem-key" }));
    expect(credential).toMatchObject({
      username: person.username,
      role: person.role,
      orgKey: person.orgKey,
    });
  });

  it("mints every call when the cache is disabled", async () => {
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const resolveJwtKey = vi.fn<(org: HenrySfOrg) => Promise<string>>().mockResolvedValue("pem");
    const service = createCredentialService({
      config: buildConfig({ credentialCacheSeconds: 0 }),
      resolveJwtKey,
      mint,
      now: () => 0,
    });

    await service.forPerson(person);
    await service.forPerson(person);

    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent calls even when the cache is disabled", async () => {
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const resolveJwtKey = vi.fn<(org: HenrySfOrg) => Promise<string>>().mockResolvedValue("pem");
    const service = createCredentialService({
      config: buildConfig({ credentialCacheSeconds: 0 }),
      resolveJwtKey,
      mint,
      now: () => 0,
    });

    await Promise.all([service.forPerson(person), service.forPerson(person)]);
    expect(mint).toHaveBeenCalledTimes(1);

    await service.forPerson(person);
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
