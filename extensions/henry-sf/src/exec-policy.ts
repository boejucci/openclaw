import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import type { ResolvedHenrySfConfig } from "./config.js";

export type SfVerdict = "read" | "write" | "denied";
export type SfInvocation = { subcommand: string; verdict: SfVerdict; reason?: string };
export type ExecCommandClass = { invocations: SfInvocation[]; verdict: SfVerdict | "none" };

// Stored without a trailing period: this file's own blockReason template and the
// shim's stderr template each punctuate the rendered message differently, so the
// shared reason text stays a clean fragment for both to splice in.
const SESSION_CREDENTIAL_REASON =
  "its output or behaviour exposes session credentials; the shim already signs you in";
const SFDX_DENIED_REASON = "use sf";

/**
 * Read / denied subcommands for the `sf` CLI. Read entries are exact and win
 * first, so `org list metadata` stays readable; denied entries then cover the
 * subcommand and everything under it (`org login jwt`, `auth list`), because
 * each of those can print a live session credential. Everything else
 * classifies as write (fail closed). The shim (Task 6) has no imports outside
 * `node:`, so it mirrors this table verbatim instead of importing it.
 */
export const SF_POLICY_TABLE = {
  denied: {
    "org display": SESSION_CREDENTIAL_REASON,
    "org open": SESSION_CREDENTIAL_REASON,
    "org list": SESSION_CREDENTIAL_REASON,
    "org login": SESSION_CREDENTIAL_REASON,
    "org logout": SESSION_CREDENTIAL_REASON,
    auth: SESSION_CREDENTIAL_REASON,
  },
  read: [
    "org list metadata",
    "org list metadata-types",
    "org list limits",
    "limits api display",
    "data query",
    "data export",
    "data search",
    "data resume",
    "sobject describe",
    "sobject list",
    "schema generate",
    "project retrieve start",
    "project retrieve preview",
    "project retrieve report",
    "project deploy preview",
    "project deploy report",
    "apex list log",
    "apex get log",
    "apex tail log",
    "apex get test",
    "apex list",
    "config list",
    "config get",
    "alias list",
    "plugins",
    "commands",
    "help",
    "version",
    // Bare `--version` / `--help` normalize to no subcommand words at all.
    "",
    "doctor",
  ],
} as const satisfies { denied: Record<string, string>; read: readonly string[] };

const DENIED_REASONS = new Map<string, string>(Object.entries(SF_POLICY_TABLE.denied));
const READ_SUBCOMMANDS = new Set<string>(SF_POLICY_TABLE.read);

function splitLeadingColonForm(argv: readonly string[]): string[] {
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith("-") || !first.includes(":")) {
    return [...argv];
  }
  const parts = first.split(":").filter((part) => part.length > 0);
  const withoutForce = parts[0] === "force" ? parts.slice(1) : parts;
  return [...withoutForce, ...rest];
}

// Leading flags (e.g. `--json` before the topic) are skipped, not stop signs;
// the first flag encountered once real subcommand words are collecting is a
// stop sign, since anything after that is a flag or a flag's value.
function collectSubcommandWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  let collecting = false;
  for (const token of argv) {
    if (token.startsWith("-")) {
      if (collecting) {
        break;
      }
      continue;
    }
    collecting = true;
    words.push(token);
  }
  return words;
}

function findDeniedReason(subcommand: string): string | undefined {
  for (const [key, reason] of DENIED_REASONS) {
    if (subcommand === key || subcommand.startsWith(`${key} `)) {
      return reason;
    }
  }
  return undefined;
}

/** Normalizes one argv (after the `sf` token) to a subcommand and classifies it. */
export function classifySfArgv(argv: readonly string[]): SfInvocation {
  const words = collectSubcommandWords(splitLeadingColonForm(argv));
  const subcommand = words.join(" ");
  if (READ_SUBCOMMANDS.has(subcommand)) {
    return { subcommand, verdict: "read" };
  }
  const deniedReason = findDeniedReason(subcommand);
  if (deniedReason !== undefined) {
    return { subcommand, verdict: "denied", reason: deniedReason };
  }
  return { subcommand, verdict: "write" };
}

function basename(token: string): string {
  const lastSlash = token.lastIndexOf("/");
  return lastSlash === -1 ? token : token.slice(lastSlash + 1);
}

const SEGMENT_SEPARATORS = new Set([";", "|", "(", ")", "`", "\n"]);

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
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
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (SEGMENT_SEPARATORS.has(ch)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
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

const SHELL_SKIP_WORDS = new Set(["env", "command", "exec", "nohup", "time", "sudo"]);
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function findInvocationTokens(tokens: readonly string[]): string[] | undefined {
  let index = 0;
  while (
    index < tokens.length &&
    (ASSIGNMENT_PATTERN.test(tokens[index]) || SHELL_SKIP_WORDS.has(tokens[index]))
  ) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index) : undefined;
}

function aggregateVerdict(invocations: readonly SfInvocation[]): SfVerdict | "none" {
  if (invocations.some((invocation) => invocation.verdict === "denied")) {
    return "denied";
  }
  if (invocations.some((invocation) => invocation.verdict === "write")) {
    return "write";
  }
  if (invocations.some((invocation) => invocation.verdict === "read")) {
    return "read";
  }
  return "none";
}

/** Finds every sf/sfdx invocation in a shell command string and classifies the whole command. */
export function classifyExecCommand(command: string): ExecCommandClass {
  const invocations: SfInvocation[] = [];
  for (const segment of splitShellSegments(command)) {
    const invocationTokens = findInvocationTokens(tokenizeSegment(segment));
    if (!invocationTokens) {
      continue;
    }
    const [binaryToken, ...args] = invocationTokens;
    const bin = basename(binaryToken);
    if (bin === "sf") {
      invocations.push(classifySfArgv(args));
    } else if (bin === "sfdx") {
      // Every sfdx invocation is denied regardless of its own verdict; reuse
      // classifySfArgv only to recover a readable normalized subcommand.
      const normalized = classifySfArgv(args);
      invocations.push({
        subcommand: normalized.subcommand,
        verdict: "denied",
        reason: SFDX_DENIED_REASON,
      });
    }
  }
  return { invocations, verdict: aggregateVerdict(invocations) };
}

function findByVerdict(
  invocations: readonly SfInvocation[],
  verdict: SfVerdict,
): SfInvocation | undefined {
  return invocations.find((invocation) => invocation.verdict === verdict);
}

type SfExecPolicyHandler = (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => PluginHookBeforeToolCallResult | undefined;

export function createExecPolicyHook(params: {
  config: ResolvedHenrySfConfig;
}): SfExecPolicyHandler {
  const { config } = params;
  return (event, ctx) => {
    const command = event.params.command;
    if (typeof command !== "string") {
      return undefined;
    }
    const classified = classifyExecCommand(command);
    if (classified.verdict === "none") {
      return undefined;
    }
    const senderId = ctx.requester?.senderId;
    const person = senderId ? config.people.get(senderId) : undefined;
    if (!person) {
      return {
        block: true,
        blockReason:
          "Salesforce commands run as the person asking, and this run has no Henry-provisioned requester.",
      };
    }
    if (classified.verdict === "denied") {
      const denied = findByVerdict(classified.invocations, "denied");
      return {
        block: true,
        blockReason: `sf ${denied?.subcommand ?? ""} is disabled here: ${denied?.reason ?? ""}.`,
      };
    }
    if (classified.verdict === "write" && person.role === "member") {
      const write = findByVerdict(classified.invocations, "write");
      return {
        block: true,
        blockReason: `sf ${write?.subcommand ?? ""} changes Salesforce and needs an admin. Draft the exact command and ask Joe to run it.`,
      };
    }
    return undefined;
  };
}
