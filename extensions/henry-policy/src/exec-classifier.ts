/**
 * exec-classifier.ts
 *
 * Classifies a shell command string as "pure-sf" or "generic" for the purpose
 * of deciding which policy rule to evaluate in henry-policy.
 *
 * "pure-sf"  — every invocation in the command is the `sf` CLI and nothing
 *               else executes. This allows henry-policy to match an `exec:sf`
 *               rule (granting sf usage) rather than the coarser `exec` rule.
 *               Henry-sf at priority 100 then enforces read-vs-write policy
 *               within those sf commands; the two layers are additive.
 *
 * "generic"  — anything else: a non-sf invocation anywhere in the command, a
 *               pipe, a redirection, a command substitution ($( or backtick),
 *               or a subshell. Fail-closed toward "generic" so that unknown
 *               shell constructs cannot slip through as "pure-sf".
 *
 * Accepted consequence: `sf … | head` classifies as "generic". Members who
 * want to inspect sf output should let Henry post-process the result instead
 * of piping. This is intentional; a pipe could feed into an arbitrary command.
 */

function basename(token: string): string {
  const lastSlash = token.lastIndexOf("/");
  return lastSlash === -1 ? token : token.slice(lastSlash + 1);
}

const SHELL_SKIP_WORDS = new Set(["env", "command", "exec", "nohup", "time", "sudo"]);
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip leading VAR=value assignments and wrapper words (env/command/exec/
 * nohup/time/sudo) from a token list to find the real invocation token.
 * Returns undefined if the segment is empty after stripping.
 */
function findInvocationToken(tokens: readonly string[]): string | undefined {
  let index = 0;
  while (
    index < tokens.length &&
    (ASSIGNMENT_PATTERN.test(tokens[index]!) || SHELL_SKIP_WORDS.has(tokens[index]!))
  ) {
    index += 1;
  }
  return index < tokens.length ? tokens[index] : undefined;
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: string | undefined;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

export type ExecCommandClass = "pure-sf" | "generic";

/**
 * Classify a shell command string as "pure-sf" or "generic".
 *
 * Fail-closed rules (any of these → "generic"):
 *  - Empty or whitespace-only input
 *  - A pipe character `|` anywhere (including `||`)
 *  - A redirection (`>`, `>>`, `<`) anywhere
 *  - A command substitution `$(` or backtick anywhere
 *  - A subshell `(` `)` anywhere (already blocked by backtick / pipe check,
 *    but we detect `(` explicitly as well)
 *  - Any non-sf invocation in any segment after stripping wrappers
 *  - A segment whose first invocation token contains `$` (catches `sf$(evil)`)
 *
 * "pure-sf" requires:
 *  - At least one segment whose invocation token's basename is `sf`
 *  - No segment with a non-sf invocation
 *  - None of the fail-closed shell constructs listed above
 *
 * Chaining: multiple sf-only commands separated by `;` or `&&` (no
 * pipes/redirects/substitutions) → "pure-sf".
 */
export function classifyExecCommand(command: string): ExecCommandClass {
  if (command.trim() === "") {
    return "generic";
  }

  // Fast-path: any pipe, redirection, command substitution, or subshell
  // anywhere in the raw string → "generic" immediately (no per-segment scan).
  // We scan the raw string (outside of quotes) for these characters.
  //
  // Note: we check the raw string but skip quoted regions to avoid false
  // positives from e.g. sf data query -q 'SELECT Id > 0 FROM Account'.
  // An unbalanced open quote accumulates the rest of the input into the last
  // token (conservative: the shell would reject such a command anyway).
  // sfdx is not sf; it classifies as generic and falls to the exec rule
  // (henry-sf separately denies sfdx subcommands at priority 100).
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // Pipe character — includes `||`
    if (ch === "|") {
      return "generic";
    }
    // Lone & is the background operator (unknown construct → fail closed);
    // && is a chaining separator handled by splitSafeSegments, so skip pairs.
    if (ch === "&") {
      if (i + 1 < command.length && command[i + 1] === "&") {
        i += 1;
      } else {
        return "generic";
      }
      continue;
    }
    // Redirection, including << heredocs (caught on the first <)
    if (ch === ">" || ch === "<") {
      return "generic";
    }
    // Command substitution: $( or backtick
    if (ch === "`") {
      return "generic";
    }
    if (ch === "$" && i + 1 < command.length && command[i + 1] === "(") {
      return "generic";
    }
    // Subshell via bare ( — but not inside a word like $(
    if (ch === "(" || ch === ")") {
      return "generic";
    }
  }

  // Split on newlines and ; && — these are the only chaining operators left
  // after the fast-path filtering above.
  const segments = splitSafeSegments(command);

  let foundSf = false;

  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    if (tokens.length === 0) {
      continue;
    }
    const invocationToken = findInvocationToken(tokens);
    if (invocationToken === undefined) {
      // Only env assignments / wrappers, no real invocation — skip silently.
      continue;
    }
    // Guard: if the token itself contains a $ (e.g. sf$(evil)), fail closed.
    if (invocationToken.includes("$")) {
      return "generic";
    }
    const bin = basename(invocationToken);
    if (bin === "sf") {
      foundSf = true;
    } else {
      // Non-sf invocation found → generic
      return "generic";
    }
  }

  return foundSf ? "pure-sf" : "generic";
}

/**
 * Split a shell command on ; && and newlines. Respects single/double quotes.
 * Pipe and other operators have already been rejected by the fast-path above,
 * so we only need to handle these safe chaining operators here.
 */
function splitSafeSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    // Newline → segment boundary
    if (ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    // ; → segment boundary
    if (ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    // && → segment boundary (consume both chars)
    if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}
