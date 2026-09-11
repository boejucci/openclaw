import { describe, expect, it } from "vitest";
import { evaluateAccess, parseAccessPolicy } from "./access.js";

describe("parseAccessPolicy", () => {
  it("empty object falls back to globalDefault with no rules", () => {
    const policy = parseAccessPolicy({}, "deny");
    expect(policy.defaultVerdict).toBe("deny");
    expect(policy.rules).toHaveLength(0);
  });

  it("empty object with allow globalDefault", () => {
    const policy = parseAccessPolicy({}, "allow");
    expect(policy.defaultVerdict).toBe("allow");
    expect(policy.rules).toHaveLength(0);
  });

  it("valid policy with three rules preserves order", () => {
    const raw = {
      defaultVerdict: "deny",
      rules: [
        { glob: "read", verdict: "allow" },
        { glob: "exec", verdict: "deny" },
        { glob: "web_fetch", verdict: "allow" },
      ],
    };
    const policy = parseAccessPolicy(raw, "deny");
    expect(policy.defaultVerdict).toBe("deny");
    expect(policy.rules).toHaveLength(3);
    expect(policy.rules[0]).toEqual({ glob: "read", verdict: "allow" });
    expect(policy.rules[1]).toEqual({ glob: "exec", verdict: "deny" });
    expect(policy.rules[2]).toEqual({ glob: "web_fetch", verdict: "allow" });
  });

  it("verdict approval in a rule is preserved", () => {
    const raw = {
      defaultVerdict: "deny",
      rules: [{ glob: "mcp:monday:*", verdict: "approval" }],
    };
    const policy = parseAccessPolicy(raw, "deny");
    expect(policy.rules[0]?.verdict).toBe("approval");
  });

  it("malformed rule missing glob is skipped; policy still parses", () => {
    const raw = {
      defaultVerdict: "deny",
      rules: [{ verdict: "allow" }, { glob: "read", verdict: "allow" }],
    };
    const policy = parseAccessPolicy(raw, "deny");
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]).toEqual({ glob: "read", verdict: "allow" });
  });

  it("completely malformed JSONB (string) falls back to safe default", () => {
    const policy = parseAccessPolicy("not-an-object", "deny");
    expect(policy.defaultVerdict).toBe("deny");
    expect(policy.rules).toHaveLength(0);
  });

  it("completely malformed JSONB (number) falls back to safe default", () => {
    const policy = parseAccessPolicy(42, "allow");
    expect(policy.defaultVerdict).toBe("allow");
    expect(policy.rules).toHaveLength(0);
  });

  it("null falls back to safe default", () => {
    const policy = parseAccessPolicy(null, "deny");
    expect(policy.defaultVerdict).toBe("deny");
    expect(policy.rules).toHaveLength(0);
  });
});

describe("evaluateAccess", () => {
  it("no matching rule returns defaultVerdict", () => {
    const policy = parseAccessPolicy({ defaultVerdict: "deny", rules: [] }, "deny");
    expect(evaluateAccess(policy, "exec")).toBe("deny");
  });

  it("mcp:monday:* rule matches mcp:monday:create_item", () => {
    const policy = parseAccessPolicy(
      {
        defaultVerdict: "deny",
        rules: [{ glob: "mcp:monday:*", verdict: "allow" }],
      },
      "deny",
    );
    expect(evaluateAccess(policy, "mcp:monday:create_item")).toBe("allow");
  });

  it("allow default with exec deny: exec denied, read allowed", () => {
    const policy = parseAccessPolicy(
      {
        defaultVerdict: "allow",
        rules: [{ glob: "exec", verdict: "deny" }],
      },
      "allow",
    );
    expect(evaluateAccess(policy, "exec")).toBe("deny");
    expect(evaluateAccess(policy, "read")).toBe("allow");
  });

  it("first matching rule wins; later rules cannot override", () => {
    const policy = parseAccessPolicy(
      {
        defaultVerdict: "deny",
        rules: [
          { glob: "read", verdict: "allow" },
          { glob: "read", verdict: "deny" },
        ],
      },
      "deny",
    );
    expect(evaluateAccess(policy, "read")).toBe("allow");
  });
});
