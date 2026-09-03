import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyArgv, sweepStaleHomes } from "./sf.mjs";

const SHIM_PATH = fileURLToPath(new URL("./sf.mjs", import.meta.url));
const GOOD_RUN_TOKEN = "good-run-token";
const ACCESS_TOKEN = "TOKEN-secret-123";
const INSTANCE_URL = "https://isi.my.salesforce.com";

type CredentialRole = "admin" | "member";
type CredentialServer = { server: http.Server; port: number; state: { received: number } };
type SharedFixture = { category: string; argv: string[] };
type ShimResult = { status: number | null; stdout: string; stderr: string };

const FAKE_SF_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const logPath = process.env.FAKE_SF_LOG;
if (logPath) {
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      home: process.env.HOME,
      hasToken: Boolean(process.env.SF_ACCESS_TOKEN),
      hasRunToken: Boolean(process.env.HENRY_SF_RUN_TOKEN),
    }) + "\\n",
  );
}
process.stdout.write("ok " + (process.argv[2] || "") + "\\n");
if (process.env.FAKE_SF_STDERR) {
  process.stderr.write(process.env.FAKE_SF_STDERR);
}
process.exit(Number(process.env.FAKE_SF_EXIT || "0"));
`;

function writeFakeSf(dir: string): string {
  const scriptPath = path.join(dir, "sf");
  writeFileSync(scriptPath, FAKE_SF_SOURCE);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// The shim is invoked with node's async spawn (not spawnSync): the shim
// makes a loopback HTTP call back into this same test process's credential
// server, and spawnSync's blocking wait starves that process's event loop,
// so the server could never answer and every call would hang until timeout.
function runShim(args: string[], env: NodeJS.ProcessEnv): Promise<ShimResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM_PATH, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function startCredentialServer(role: CredentialRole): Promise<CredentialServer> {
  const state = { received: 0 };
  const server = http.createServer((req, res) => {
    state.received += 1;
    const auth = req.headers.authorization ?? "";
    if (auth === `Bearer ${GOOD_RUN_TOKEN}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          username: "person@isidefense.com",
          instanceUrl: INSTANCE_URL,
          accessToken: ACCESS_TOKEN,
          role,
        }),
      );
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_run_token" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback server address");
  }
  return { server, port: address.port, state };
}

function buildShimEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

describe("henry-sf shim: run() behavior", () => {
  let tempRoot: string;
  let fakeSfPath: string;
  let runRoot: string;
  let logPath: string;
  let server: CredentialServer | undefined;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "henry-sf-shim-test-")));
    fakeSfPath = writeFakeSf(tempRoot);
    runRoot = mkdtempSync(path.join(tempRoot, "run-root-"));
    logPath = path.join(tempRoot, "fake-sf.log");
  });

  afterEach(async () => {
    const activeServer = server;
    server = undefined;
    if (activeServer) {
      await new Promise<void>((resolve, reject) => {
        activeServer.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function readLog(): Array<Record<string, unknown>> {
    if (!existsSync(logPath)) {
      return [];
    }
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return buildShimEnv({
      HENRY_SF_RUN_TOKEN: GOOD_RUN_TOKEN,
      HENRY_SF_CREDENTIAL_URL: server
        ? `http://127.0.0.1:${server.port}/henry/sf/credential`
        : undefined,
      HENRY_SF_REAL_BIN: fakeSfPath,
      HENRY_SF_RUN_ROOT: runRoot,
      FAKE_SF_LOG: logPath,
      ...overrides,
    });
  }

  it("case 1: signs in then runs a read command under a shared throwaway HOME", async () => {
    server = await startCredentialServer("member");

    const result = await runShim(["data", "query", "-q", "SELECT Id FROM Account"], baseEnv());

    expect(result.status, result.stderr).toBe(0);
    const entries = readLog();
    expect(entries).toHaveLength(2);

    expect(entries[0]).toMatchObject({ hasToken: true, hasRunToken: false });
    expect(entries[0].argv).toEqual([
      "org",
      "login",
      "access-token",
      "--instance-url",
      INSTANCE_URL,
      "--no-prompt",
      "--set-default",
      "--alias",
      "henry",
      "--json",
    ]);

    expect(entries[1]).toMatchObject({ hasToken: false, hasRunToken: false });
    expect(entries[1].argv).toEqual(["data", "query", "-q", "SELECT Id FROM Account"]);

    expect(entries[0].home).toBe(entries[1].home);
    expect(String(entries[0].home).startsWith(runRoot)).toBe(true);
    expect(entries[0].home).not.toBe(process.env.HOME);
    expect(existsSync(String(entries[0].home))).toBe(false);

    expect(result.stdout).toContain("ok data");
    expect(result.stdout).not.toContain("ok org");
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
  });

  it("case 2: a member's write command is blocked before Salesforce is touched", async () => {
    server = await startCredentialServer("member");

    const result = await runShim(["project", "deploy", "start"], baseEnv());

    expect(result.status).toBe(77);
    expect(readLog()).toHaveLength(0);
    expect(result.stderr).toContain("needs an admin");
  });

  it("case 3: an admin's write command runs", async () => {
    server = await startCredentialServer("admin");

    const result = await runShim(["project", "deploy", "start"], baseEnv());

    expect(result.status, result.stderr).toBe(0);
    expect(readLog()).toHaveLength(2);
  });

  it("case 4: org display is refused even for an admin", async () => {
    server = await startCredentialServer("admin");

    const result = await runShim(["org", "display"], baseEnv());

    expect(result.status).toBe(77);
    expect(readLog()).toHaveLength(0);
    expect(result.stderr).toContain("disabled here");
  });

  it("case 5: a missing run token fails closed without contacting the credential route", async () => {
    server = await startCredentialServer("admin");

    const result = await runShim(
      ["data", "query", "-q", "SELECT Id FROM Account"],
      baseEnv({ HENRY_SF_RUN_TOKEN: undefined }),
    );

    expect(result.status).toBe(78);
    expect(server.state.received).toBe(0);
  });

  it("case 6: an invalid run token fails without echoing it", async () => {
    server = await startCredentialServer("admin");

    const result = await runShim(
      ["data", "query", "-q", "SELECT Id FROM Account"],
      baseEnv({ HENRY_SF_RUN_TOKEN: "bad" }),
    );

    expect(result.status).toBe(70);
    expect(server.state.received).toBe(1);
    expect(result.stderr).not.toContain("bad");
  });

  it("case 9: denied subcommands cover everything under them, before any credential fetch", async () => {
    server = await startCredentialServer("admin");

    for (const argv of [
      ["org", "login", "jwt", "--username", "x"],
      ["auth", "list"],
      ["org", "logout", "--all"],
    ]) {
      const result = await runShim(argv, baseEnv());
      expect(result.status, JSON.stringify(argv)).toBe(77);
      expect(result.stderr).toContain("disabled here");
    }
    expect(server.state.received).toBe(0);
    expect(readLog()).toHaveLength(0);
  });

  it("case 10: sweeps throwaway homes older than an hour and leaves everything else", () => {
    const stale = mkdtempSync(path.join(runRoot, "henry-sf-"));
    const fresh = mkdtempSync(path.join(runRoot, "henry-sf-"));
    const unrelated = path.join(runRoot, "other");
    mkdirSync(unrelated);
    const twoHoursAgoSeconds = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, twoHoursAgoSeconds, twoHoursAgoSeconds);

    expect(sweepStaleHomes(runRoot)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(sweepStaleHomes(path.join(runRoot, "missing"))).toBe(0);
  });

  it("case 7: a failed sign-in redacts the access token", async () => {
    server = await startCredentialServer("member");

    const result = await runShim(
      ["data", "query", "-q", "SELECT Id FROM Account"],
      baseEnv({ FAKE_SF_EXIT: "2", FAKE_SF_STDERR: `boom ${ACCESS_TOKEN}` }),
    );

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("[redacted]");
    expect(result.stderr).not.toContain(ACCESS_TOKEN);
  });
});

describe("henry-sf shim: classifyArgv", () => {
  const SHARED_FIXTURES: SharedFixture[] = [
    { category: "read", argv: ["data", "query", "-q", "SELECT Id FROM Account"] },
    { category: "read", argv: ["data", "export"] },
    { category: "read", argv: ["sobject", "describe", "-s", "Account"] },
    { category: "read", argv: ["org", "list", "metadata"] },
    { category: "read", argv: ["apex", "list", "log"] },
    { category: "read", argv: ["--json", "data", "query", "-q", "SELECT Id FROM Account"] },
    { category: "write", argv: ["project", "deploy", "start"] },
    { category: "write", argv: ["data", "create", "record", "-s", "Account"] },
    { category: "write", argv: ["apex", "run"] },
    { category: "write", argv: ["org", "create", "scratch"] },
    { category: "denied", argv: ["org", "display"] },
    { category: "denied", argv: ["org", "list"] },
    { category: "denied", argv: ["auth"] },
    { category: "denied", argv: ["auth", "list"] },
    { category: "denied", argv: ["org", "login", "jwt", "--username", "x"] },
    { category: "denied", argv: ["org", "logout", "--all"] },
    { category: "denied", argv: ["org", "open", "--url-only"] },
    { category: "read", argv: ["org", "list", "metadata", "--json"] },
    { category: "read", argv: [] },
    { category: "read", argv: ["--json"] },
    { category: "colon-form", argv: ["force:org:display"] },
    { category: "colon-form", argv: ["force:data:soql:query"] },
    { category: "sfdx", argv: ["sfdx"] },
  ];

  let task5ClassifySfArgv:
    | ((argv: readonly string[]) => { subcommand: string; verdict: string; reason?: string })
    | undefined;

  beforeAll(async () => {
    try {
      const mod: Record<string, unknown> = await import("../src/exec-policy.js");
      if (typeof mod.classifySfArgv === "function") {
        task5ClassifySfArgv = mod.classifySfArgv as typeof task5ClassifySfArgv;
      }
    } catch {
      task5ClassifySfArgv = undefined;
    }
  });

  it("case 8: agrees with Task 5's classifySfArgv on shared fixtures", (ctx) => {
    if (!task5ClassifySfArgv) {
      ctx.skip();
      return;
    }
    const classifySfArgv = task5ClassifySfArgv;
    for (const fixture of SHARED_FIXTURES) {
      const shimVerdict = classifyArgv(fixture.argv).verdict;
      const task5Verdict = classifySfArgv(fixture.argv).verdict;
      expect(task5Verdict, `${fixture.category}: ${JSON.stringify(fixture.argv)}`).toBe(
        shimVerdict,
      );
    }
  });
});
