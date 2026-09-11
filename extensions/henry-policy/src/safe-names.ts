/**
 * Replicates the sanitization semantics of
 * src/agents/agent-bundle-mcp-names.ts (the source of truth).
 *
 * This module is intentionally self-contained — it may NOT import from
 * agent-bundle-mcp-names.ts due to the plugin-sdk boundary.
 */

// Mirrors TOOL_NAME_SAFE_RE and TOOL_NAME_MAX_PREFIX from the source of truth.
const TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_-]/g;
const TOOL_NAME_MAX_PREFIX = 30;

/**
 * Lowercases a trimmed string or returns "" for non-strings or blank strings.
 * Mirrors normalizeLowercaseStringOrEmpty from @openclaw/normalization-core/string-coerce.
 */
function normalizeLowercaseStringOrEmpty(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : "";
}

/**
 * Mirrors sanitizeToolFragment(raw, "mcp", TOOL_NAME_MAX_PREFIX) from the source of truth.
 * Case is PRESERVED in the returned name; only the collision-reservation set is lowercased.
 */
function sanitizeServerFragment(raw: string): string {
  const fallback = "mcp";
  const cleaned = raw.trim().replace(TOOL_NAME_SAFE_RE, "-");
  const normalized = cleaned || fallback;
  const providerSafe = /^[A-Za-z]/.test(normalized) ? normalized : `${fallback}-${normalized}`;
  return providerSafe.length > TOOL_NAME_MAX_PREFIX
    ? providerSafe.slice(0, TOOL_NAME_MAX_PREFIX)
    : providerSafe;
}

/**
 * Mirrors sanitizeServerName(raw, usedNames) from the source of truth.
 * Resolves collision by appending -2, -3, … while keeping within TOOL_NAME_MAX_PREFIX.
 * Reserves the lowercased form in usedNames (collision detection is case-insensitive).
 */
function sanitizeServerName(raw: string, usedNames: Set<string>): string {
  const base = sanitizeServerFragment(raw);
  let candidate = base;
  let n = 2;
  while (usedNames.has(normalizeLowercaseStringOrEmpty(candidate))) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, Math.max(1, TOOL_NAME_MAX_PREFIX - suffix.length))}${suffix}`;
    n += 1;
  }
  usedNames.add(normalizeLowercaseStringOrEmpty(candidate));
  return candidate;
}

/**
 * Mirrors assignSafeServerNames from the source of truth, but returns an inverted map:
 * safeName → configKey.
 *
 * Declaration order must be preserved (same collision-suffix ownership rules).
 *
 * @param configKeys - The raw MCP server config keys in declaration order.
 * @returns A ReadonlyMap from safe model-facing server name → original config key.
 */
export function buildSafeServerNameMap(configKeys: readonly string[]): ReadonlyMap<string, string> {
  const usedNames = new Set<string>();
  const result = new Map<string, string>();
  for (const key of configKeys) {
    const safeName = sanitizeServerName(key, usedNames);
    result.set(safeName, key);
  }
  return result;
}
