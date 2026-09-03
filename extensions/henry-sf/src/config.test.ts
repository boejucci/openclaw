// Henry-sf tests cover config resolution and cross-reference validation.
import { describe, expect, it } from "vitest";
import { findPerson, resolveHenrySfConfig } from "./config.js";

describe("resolveHenrySfConfig", () => {
  it("resolves an empty config to empty maps and documented defaults", () => {
    for (const pluginConfig of [{}, undefined]) {
      const config = resolveHenrySfConfig({ pluginConfig });
      expect(config.people.size).toBe(0);
      expect(config.orgs.size).toBe(0);
      expect(config.routePath).toBe("/henry/sf/credential");
      expect(config.runTokenTtlSeconds).toBe(900);
      expect(config.credentialCacheSeconds).toBe(1800);
      expect(config).not.toHaveProperty("credentialUrl");
    }
  });

  it("assigns a person without org to the single default org and defaults loginUrl", () => {
    const config = resolveHenrySfConfig({
      pluginConfig: {
        orgs: {
          prod: {
            instanceUrl: "https://acme.my.salesforce.com",
            clientId: "client-123",
            jwtKey: "SF_JWT_KEY",
            default: true,
          },
        },
        people: {
          joe: { username: "joe@acme.com", role: "admin" },
        },
      },
    });

    expect(config.people.get("joe")).toEqual({
      profileId: "joe",
      username: "joe@acme.com",
      role: "admin",
      orgKey: "prod",
    });
    expect(config.orgs.get("prod")?.loginUrl).toBe("https://login.salesforce.com");
  });

  it("throws naming people.<id>.org when a person references an undeclared org", () => {
    expect(() =>
      resolveHenrySfConfig({
        pluginConfig: {
          orgs: {
            prod: {
              instanceUrl: "https://acme.my.salesforce.com",
              clientId: "client-123",
              jwtKey: "SF_JWT_KEY",
            },
          },
          people: {
            joe: { username: "joe@acme.com", role: "admin", org: "sandbox" },
          },
        },
      }),
    ).toThrow(
      /plugins\.entries\.henry-sf\.config\.people\.joe\.org references unknown org "sandbox"/,
    );
  });

  it("throws when two orgs are marked default and a person omits org", () => {
    expect(() =>
      resolveHenrySfConfig({
        pluginConfig: {
          orgs: {
            prod: {
              instanceUrl: "https://acme.my.salesforce.com",
              clientId: "c1",
              jwtKey: "K1",
              default: true,
            },
            sandbox: {
              instanceUrl: "https://acme--sbx.my.salesforce.com",
              clientId: "c2",
              jwtKey: "K2",
              default: true,
            },
          },
          people: {
            joe: { username: "joe@acme.com", role: "admin" },
          },
        },
      }),
    ).toThrow(
      /plugins\.entries\.henry-sf\.config\.orgs must mark exactly one org as default.*found 2 default orgs/,
    );
  });

  it("throws when a person omits org and no org is marked default", () => {
    expect(() =>
      resolveHenrySfConfig({
        pluginConfig: {
          orgs: {
            prod: { instanceUrl: "https://acme.my.salesforce.com", clientId: "c1", jwtKey: "K1" },
          },
          people: {
            joe: { username: "joe@acme.com", role: "admin" },
          },
        },
      }),
    ).toThrow(
      /plugins\.entries\.henry-sf\.config\.orgs must mark exactly one org as default.*found 0 default orgs/,
    );
  });

  it("accepts a plain string or SecretRef jwtKey and rejects any other shape", () => {
    const withStringKey = resolveHenrySfConfig({
      pluginConfig: {
        orgs: {
          prod: {
            instanceUrl: "https://acme.my.salesforce.com",
            clientId: "c1",
            jwtKey: "SF_JWT_KEY",
          },
        },
      },
    });
    expect(withStringKey.orgs.get("prod")?.jwtKey).toBe("SF_JWT_KEY");

    const withSecretRefKey = resolveHenrySfConfig({
      pluginConfig: {
        orgs: {
          prod: {
            instanceUrl: "https://acme.my.salesforce.com",
            clientId: "c1",
            jwtKey: { source: "env", provider: "default", id: "SF_JWT_KEY" },
          },
        },
      },
    });
    expect(withSecretRefKey.orgs.get("prod")?.jwtKey).toEqual({
      source: "env",
      provider: "default",
      id: "SF_JWT_KEY",
    });

    expect(() =>
      resolveHenrySfConfig({
        pluginConfig: {
          orgs: {
            prod: { instanceUrl: "https://acme.my.salesforce.com", clientId: "c1", jwtKey: 12345 },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level config keys", () => {
    expect(() => resolveHenrySfConfig({ pluginConfig: { unknownKey: true } })).toThrow();
  });

  it("strips exactly one trailing slash from instanceUrl and loginUrl", () => {
    const config = resolveHenrySfConfig({
      pluginConfig: {
        orgs: {
          prod: {
            instanceUrl: "https://acme.my.salesforce.com/",
            loginUrl: "https://login.salesforce.com//",
            clientId: "c1",
            jwtKey: "K1",
          },
        },
      },
    });

    const org = config.orgs.get("prod");
    expect(org?.instanceUrl).toBe("https://acme.my.salesforce.com");
    expect(org?.loginUrl).toBe("https://login.salesforce.com/");
  });
});

describe("findPerson", () => {
  it("returns the matching person for a known id, and undefined otherwise", () => {
    const config = resolveHenrySfConfig({
      pluginConfig: {
        orgs: {
          prod: {
            instanceUrl: "https://acme.my.salesforce.com",
            clientId: "c1",
            jwtKey: "K1",
            default: true,
          },
        },
        people: {
          joe: { username: "joe@acme.com", role: "admin" },
        },
      },
    });

    expect(findPerson(config, "joe")).toEqual({
      profileId: "joe",
      username: "joe@acme.com",
      role: "admin",
      orgKey: "prod",
    });
    expect(findPerson(config, undefined)).toBeUndefined();
    expect(findPerson(config, "")).toBeUndefined();
    expect(findPerson(config, "unknown-id")).toBeUndefined();
  });
});
