// Unbounded on purpose: globs come from henry_people.access, which only the
// admin writes, so the distinct-pattern population stays small.
const cache = new Map<string, RegExp>();

function toRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached !== undefined) return cached;

  // Escape all regex specials except *, then replace * with [^:]*
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^:]*");
  const re = new RegExp(`^${escaped}$`);
  cache.set(glob, re);
  return re;
}

/**
 * Returns true when toolName matches glob.
 * `*` matches any sequence of characters except `:`.
 * Exact matches always win (glob === toolName).
 */
export function matchGlob(glob: string, toolName: string): boolean {
  if (glob === "" || toolName === "") return false;
  if (glob === toolName) return true;
  return toRegExp(glob).test(toolName);
}
