/**
 * Parity fixtures for buildSafeServerNameMap.
 *
 * Each fixture documents the expected output and how it was derived from the
 * source of truth (src/agents/agent-bundle-mcp-names.ts).
 */
import { describe, expect, it } from "vitest";
import { buildSafeServerNameMap } from "./safe-names.js";

describe("buildSafeServerNameMap", () => {
  it("plain lowercase name passes through unchanged", () => {
    // "monday" → trim="monday", replace="monday", starts with letter → "monday"
    // No collision. safeName → configKey: "monday" → "monday"
    const map = buildSafeServerNameMap(["monday"]);
    expect(map.get("monday")).toBe("monday");
  });

  it("name with a dot replaces dot with hyphen", () => {
    // "my.server" → trim="my.server", replace="my-server", starts with letter → "my-server"
    const map = buildSafeServerNameMap(["my.server"]);
    expect(map.get("my-server")).toBe("my.server");
  });

  it("uppercase letters are preserved in the safe name", () => {
    // "Monday" → trim="Monday", replace="Monday" (no unsafe chars), starts with letter → "Monday"
    const map = buildSafeServerNameMap(["Monday"]);
    expect(map.get("Monday")).toBe("Monday");
  });

  it("name starting with a digit gets mcp- prefix", () => {
    // "1pass" → trim="1pass", replace="1pass", does NOT start with [A-Za-z]
    //   → providerSafe = "mcp-" + "1pass" = "mcp-1pass"
    // len=9 ≤ 30 → "mcp-1pass"
    const map = buildSafeServerNameMap(["1pass"]);
    expect(map.get("mcp-1pass")).toBe("1pass");
  });

  it("two names colliding after sanitization get -2 suffix in declaration order", () => {
    // "my.server" → "my-server" (reserved as "my-server" lowercased)
    // "my server" → trim="my server", replace="my-server" → collision with "my-server"
    //   → suffix="-2", candidate = "my-server".slice(0, 30-2) + "-2" = "my-serve" + "-2" = "my-serve-2"
    //   Wait: 30 - 2 = 28 chars from base. "my-server" is 9 chars, slice(0,28)="my-server"
    //   → candidate = "my-server-2"
    const map = buildSafeServerNameMap(["my.server", "my server"]);
    expect(map.get("my-server")).toBe("my.server");
    expect(map.get("my-server-2")).toBe("my server");
  });

  it("31+ char name is truncated to 30 chars", () => {
    // "a".repeat(31) → replace → 31 'a' chars, starts with letter → slice to 30
    const longKey = "a".repeat(31);
    const map = buildSafeServerNameMap([longKey]);
    const safeName = [...map.keys()][0]!;
    expect(safeName.length).toBe(30);
    expect(map.get(safeName)).toBe(longKey);
  });

  it("inverted map allows lookup by safe name → config key", () => {
    const map = buildSafeServerNameMap(["monday", "my.server", "1pass"]);
    expect(map.get("monday")).toBe("monday");
    expect(map.get("my-server")).toBe("my.server");
    expect(map.get("mcp-1pass")).toBe("1pass");
  });

  it("empty input returns empty map", () => {
    const map = buildSafeServerNameMap([]);
    expect(map.size).toBe(0);
  });
});
