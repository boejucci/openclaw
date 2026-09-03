#!/usr/bin/env node
// Drop-in replacement for the real `sf` binary on the Gateway's PATH: it
// signs in as the requesting person under a throwaway HOME for one command,
// then removes that HOME. See docs/plugins/henry-sf.md for the full flow.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Mirrors extensions/henry-sf/src/exec-policy.ts verbatim, including its
// order: read entries are exact and win first, denied entries then cover the
// subcommand and everything under it. Copied rather than imported: the shim
// runs on the exec host's PATH with only node: modules available to it.
const SESSION_CREDENTIAL_REASON =
  "its output or behaviour exposes session credentials; the shim already signs you in";

const DENIED_SUBCOMMANDS = new Map([
  ["org display", SESSION_CREDENTIAL_REASON],
  ["org open", SESSION_CREDENTIAL_REASON],
  ["org list", SESSION_CREDENTIAL_REASON],
  ["org login", SESSION_CREDENTIAL_REASON],
  ["org logout", SESSION_CREDENTIAL_REASON],
  ["auth", SESSION_CREDENTIAL_REASON],
]);

const READ_SUBCOMMANDS = new Set([
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
]);

const REMOVED_CHILD_ENV_KEYS = [
  "HENRY_SF_RUN_TOKEN",
  "HENRY_SF_CREDENTIAL_URL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
];

function splitLeadingColonForm(argv) {
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith("-") || !first.includes(":")) {
    return [...argv];
  }
  const parts = first.split(":").filter((part) => part.length > 0);
  const withoutForce = parts[0] === "force" ? parts.slice(1) : parts;
  return [...withoutForce, ...rest];
}

function collectSubcommandWords(argv) {
  const words = [];
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

function findDeniedReason(subcommand) {
  for (const [key, reason] of DENIED_SUBCOMMANDS) {
    if (subcommand === key || subcommand.startsWith(`${key} `)) {
      return reason;
    }
  }
  return undefined;
}

export function classifyArgv(argv) {
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

const STALE_HOME_MAX_AGE_MS = 60 * 60 * 1000;

// A shim killed mid-command (SIGKILL, host reboot) never reaches its cleanup,
// leaving a signed-in HOME with a live session token under runRoot. Each new
// invocation removes leftovers older than an hour; a live invocation keeps its
// HOME's mtime fresh through the sign-in writes.
export function sweepStaleHomes(runRoot, nowMs = Date.now(), maxAgeMs = STALE_HOME_MAX_AGE_MS) {
  let entries;
  try {
    entries = fs.readdirSync(runRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("henry-sf-")) {
      continue;
    }
    const dir = path.join(runRoot, entry.name);
    try {
      if (nowMs - fs.statSync(dir).mtimeMs < maxAgeMs) {
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best effort: a sibling invocation may be removing the same directory.
    }
  }
  return removed;
}

export function resolveRealSf(env, selfPath) {
  if (env.HENRY_SF_REAL_BIN) {
    return env.HENRY_SF_REAL_BIN;
  }

  let selfReal;
  try {
    selfReal = fs.realpathSync(selfPath);
  } catch {
    selfReal = selfPath ? path.resolve(selfPath) : undefined;
  }

  const pathDirs = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "sf");
    let candidateReal;
    try {
      candidateReal = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    // The shim is usually itself named "sf" and placed first on PATH; skip
    // that entry so the search reaches the real CLI behind it.
    if (candidateReal !== selfReal) {
      return candidate;
    }
  }
  return undefined;
}

function buildChildEnv(env, home) {
  const childEnv = { ...env };
  for (const key of REMOVED_CHILD_ENV_KEYS) {
    delete childEnv[key];
  }
  childEnv.HOME = home;
  childEnv.SF_DISABLE_TELEMETRY = "true";
  childEnv.SF_AUTOUPDATE_DISABLE = "true";
  childEnv.SF_SKIP_NEW_VERSION_CHECK = "true";
  return childEnv;
}

async function readCredentialErrorField(response) {
  try {
    const body = await response.json();
    if (body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Non-JSON error body; fall through to the generic label below.
  }
  return "unknown_error";
}

async function fetchCredential(credentialUrl, token) {
  const response = await fetch(credentialUrl, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    return {
      ok: false,
      status: response.status,
      errorField: await readCredentialErrorField(response),
    };
  }
  const body = await response.json().catch(() => null);
  const role = body && typeof body === "object" ? body.role : undefined;
  if (
    !body ||
    typeof body.instanceUrl !== "string" ||
    typeof body.accessToken !== "string" ||
    (role !== "admin" && role !== "member")
  ) {
    return { ok: false, status: response.status, errorField: "malformed_response" };
  }
  return { ok: true, credential: body };
}

function redactToken(text, token) {
  return token ? text.split(token).join("[redacted]") : text;
}

async function runShimCommand(argv, env, io) {
  const token = env.HENRY_SF_RUN_TOKEN;
  const credentialUrl = env.HENRY_SF_CREDENTIAL_URL;
  if (!token || !credentialUrl) {
    io.stderr(
      "Salesforce access is only available inside a Henry run (no run token in the environment).",
    );
    return 78;
  }

  const invocation = classifyArgv(argv);
  if (invocation.verdict === "denied") {
    io.stderr(`sf ${invocation.subcommand} is disabled here: ${invocation.reason}.`);
    return 77;
  }

  let fetchResult;
  try {
    fetchResult = await fetchCredential(credentialUrl, token);
  } catch (error) {
    fetchResult = {
      ok: false,
      status: "network_error",
      errorField: error instanceof Error ? error.message : String(error),
    };
  }
  if (!fetchResult.ok) {
    io.stderr(
      `Henry could not obtain your Salesforce credential (${fetchResult.status} ${fetchResult.errorField})`,
    );
    return 70;
  }
  const credential = fetchResult.credential;

  if (credential.role !== "admin" && invocation.verdict === "write") {
    io.stderr(
      `sf ${invocation.subcommand} changes Salesforce and needs an admin. Draft the exact command and ask Joe to run it.`,
    );
    return 77;
  }

  // Resolved before mkdtemp: nothing to clean up if the real CLI is missing.
  const realSf = resolveRealSf(env, process.argv[1]);
  if (!realSf) {
    io.stderr("The real sf CLI was not found (set HENRY_SF_REAL_BIN).");
    return 69;
  }

  const runRoot = env.HENRY_SF_RUN_ROOT || os.tmpdir();
  sweepStaleHomes(runRoot);
  const home = fs.mkdtempSync(path.join(runRoot, "henry-sf-"));
  try {
    const childEnv = buildChildEnv(env, home);

    const loginResult = spawnSync(
      realSf,
      [
        "org",
        "login",
        "access-token",
        "--instance-url",
        credential.instanceUrl,
        "--no-prompt",
        "--set-default",
        "--alias",
        "henry",
        "--json",
      ],
      {
        env: { ...childEnv, SF_ACCESS_TOKEN: credential.accessToken },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
    if (loginResult.error || loginResult.status !== 0) {
      const firstLine = redactToken(
        String(loginResult.stderr ?? "").split("\n")[0] ?? "",
        credential.accessToken,
      );
      io.stderr(`Salesforce sign-in failed for this run.${firstLine ? ` ${firstLine}` : ""}`);
      return 70;
    }

    const commandResult = spawnSync(realSf, argv, { env: childEnv, stdio: "inherit" });
    if (commandResult.error) {
      io.stderr(`Failed to run the real sf CLI: ${commandResult.error.message}`);
      return 70;
    }
    if (commandResult.signal) {
      return 1;
    }
    return commandResult.status ?? 1;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const io = {
    stderr(message) {
      process.stderr.write(`${message}\n`);
    },
  };
  process.exitCode = await runShimCommand(process.argv.slice(2), process.env, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `Henry sf shim failed unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
