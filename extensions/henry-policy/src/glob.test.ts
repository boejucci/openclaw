import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob.js";

describe("matchGlob", () => {
  const cases: [string, string, boolean][] = [
    // Exact match
    ["exec", "exec", true],
    ["read", "read", true],
    // * wildcard within a segment
    ["mcp:monday:*", "mcp:monday:create_item", true],
    ["mcp:monday:*", "mcp:monday:change_item_column_values", true],
    // * does not cross ':'
    ["mcp:*", "mcp:monday:create_item", false],
    // ** gets no special treatment — behaves like literal ** (no match)
    ["mcp:**", "mcp:monday:create_item", false],
    // Prefix without * does not match
    ["mcp:monday", "mcp:monday:create_item", false],
    // Non-match
    ["exec", "read", false],
    // Empty inputs
    ["", "exec", false],
    ["exec", "", false],
    // Literal '.' — not regex wildcard
    ["mcp:a.b:*", "mcp:axb:c", false],
    ["mcp:a.b:*", "mcp:a.b:tool", true],
    // ISI tool coverage
    ["exec", "exec", true],
    ["read", "read", true],
    ["write", "write", true],
    ["apply_patch", "apply_patch", true],
    ["web_fetch", "web_fetch", true],
    ["mcp:monday:*", "mcp:monday:change_item_column_values", true],
    // Star within segment but not matching across segments
    ["mcp:monday:create_*", "mcp:monday:create_item", true],
    ["mcp:monday:create_*", "mcp:monday:change_item_column_values", false],
    // No-star prefix non-match
    ["mcp:monday:create", "mcp:monday:create_item", false],
    // ? is a literal, never a regex quantifier (SF-1)
    ["web_fetch?", "web_fetch", false],
    ["web_fetch?", "web_fetch?", true],
  ];

  it.each(cases)("matchGlob(%j, %j) → %s", (glob, toolName, expected) => {
    expect(matchGlob(glob, toolName)).toBe(expected);
  });
});
