import { describe, expect, it } from "vitest";
import { resolveHenryPolicyConfig } from "./config.js";

describe("resolveHenryPolicyConfig", () => {
  it("applies defaults for minimal config with only db.dsn", () => {
    const config = resolveHenryPolicyConfig({
      pluginConfig: { db: { dsn: "postgres://localhost/henry" } },
    });
    expect(config.db.dsn).toBe("postgres://localhost/henry");
    expect(config.db.poolMax).toBe(2);
    expect(config.cacheTtlSeconds).toBe(60);
    expect(config.defaultVerdict).toBe("deny");
    expect(config.passthroughNoPrincipal).toBe(true);
  });

  it("accepts dsn as a SecretRef object", () => {
    const config = resolveHenryPolicyConfig({
      pluginConfig: {
        db: {
          dsn: { source: "env", provider: "default", id: "HENRY_POLICY_DSN" },
        },
      },
    });
    expect(config.db.dsn).toEqual({
      source: "env",
      provider: "default",
      id: "HENRY_POLICY_DSN",
    });
  });

  it("throws naming the config path when db is missing", () => {
    expect(() => resolveHenryPolicyConfig({ pluginConfig: {} })).toThrow(
      /plugins\.entries\.henry-policy\.config/,
    );
  });

  it("rejects unknown top-level keys (strict schema)", () => {
    expect(() =>
      resolveHenryPolicyConfig({
        pluginConfig: { db: { dsn: "postgres://localhost/henry" }, unknownKey: true },
      }),
    ).toThrow();
  });

  it("rejects poolMax: 0 (minimum is 1)", () => {
    expect(() =>
      resolveHenryPolicyConfig({
        pluginConfig: { db: { dsn: "postgres://localhost/henry", poolMax: 0 } },
      }),
    ).toThrow();
  });

  it("rejects defaultVerdict: 'block' (not in enum)", () => {
    expect(() =>
      resolveHenryPolicyConfig({
        pluginConfig: { db: { dsn: "postgres://localhost/henry" }, defaultVerdict: "block" },
      }),
    ).toThrow();
  });
});
