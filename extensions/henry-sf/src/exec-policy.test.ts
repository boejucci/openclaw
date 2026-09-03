import { describe, expect, it } from "vitest";
import type { HenrySfPerson, ResolvedHenrySfConfig } from "./config.js";
import {
  classifyExecCommand,
  classifySfArgv,
  createExecPolicyHook,
  SF_POLICY_TABLE,
} from "./exec-policy.js";

const ADMIN: HenrySfPerson = {
  profileId: "profile-joe",
  username: "joe@isidefense.com",
  role: "admin",
  orgKey: "prod",
};
const MEMBER: HenrySfPerson = {
  profileId: "profile-ada",
  username: "ada@isidefense.com",
  role: "member",
  orgKey: "prod",
};

function buildConfig(people: Record<string, HenrySfPerson>): ResolvedHenrySfConfig {
  return {
    people: new Map(Object.entries(people)),
    orgs: new Map(),
    routePath: "/henry/sf/credential",
    runTokenTtlSeconds: 900,
    credentialCacheSeconds: 1800,
  };
}

describe("classifySfArgv", () => {
  it.each(Object.entries(SF_POLICY_TABLE.denied))(
    "denies %s with the session-credential reason",
    (subcommand, reason) => {
      expect(classifySfArgv(subcommand.split(" "))).toEqual({
        subcommand,
        verdict: "denied",
        reason,
      });
    },
  );

  it.each(SF_POLICY_TABLE.read.filter((subcommand) => subcommand.length > 0))(
    "reads %s",
    (subcommand) => {
      expect(classifySfArgv(subcommand.split(" "))).toEqual({ subcommand, verdict: "read" });
    },
  );

  it("treats a bare --version flag as read", () => {
    expect(classifySfArgv(["--version"])).toEqual({ subcommand: "", verdict: "read" });
  });

  it("treats a bare --help flag as read", () => {
    expect(classifySfArgv(["--help"])).toEqual({ subcommand: "", verdict: "read" });
  });

  it("skips flags that appear before the subcommand", () => {
    expect(classifySfArgv(["--json", "data", "query", "-q", "SELECT Id FROM Account"])).toEqual({
      subcommand: "data query",
      verdict: "read",
    });
  });

  it("stops collecting subcommand words at the first flag that follows them", () => {
    expect(classifySfArgv(["data", "query", "-q", "SELECT Id FROM Account"])).toEqual({
      subcommand: "data query",
      verdict: "read",
    });
  });

  it("classifies the legacy colon form force:org:display as denied", () => {
    expect(classifySfArgv(["force:org:display"])).toEqual({
      subcommand: "org display",
      verdict: "denied",
      reason: SF_POLICY_TABLE.denied["org display"],
    });
  });

  it("classifies the legacy colon form force:data:soql:query as write because it is unknown in the new table", () => {
    expect(classifySfArgv(["force:data:soql:query"])).toEqual({
      subcommand: "data soql query",
      verdict: "write",
    });
  });

  it("classifies any unrecognized subcommand as write, fail closed", () => {
    expect(classifySfArgv(["project", "deploy", "start"])).toEqual({
      subcommand: "project deploy start",
      verdict: "write",
    });
    expect(classifySfArgv(["plugins", "install", "some-plugin"])).toEqual({
      subcommand: "plugins install some-plugin",
      verdict: "write",
    });
  });

  it("does not confuse org list metadata / metadata-types with the denied bare org list", () => {
    expect(classifySfArgv(["org", "list", "metadata"]).verdict).toBe("read");
    expect(classifySfArgv(["org", "list", "metadata-types"]).verdict).toBe("read");
    expect(classifySfArgv(["org", "list"]).verdict).toBe("denied");
  });

  it("still denies org list with a trailing formatting flag", () => {
    expect(classifySfArgv(["org", "list", "--json"])).toEqual({
      subcommand: "org list",
      verdict: "denied",
      reason: SF_POLICY_TABLE.denied["org list"],
    });
  });
});

describe("classifyExecCommand", () => {
  it("classifies a read pipeline with flags before the subcommand and a query value after", () => {
    const result = classifyExecCommand(
      "cd /work && sf data query -q 'SELECT Id FROM Account' | head",
    );
    expect(result.verdict).toBe("read");
    expect(result.invocations).toEqual([{ subcommand: "data query", verdict: "read" }]);
  });

  it("skips a leading environment assignment to find the sf invocation", () => {
    const result = classifyExecCommand("SF_LOG_LEVEL=debug sf project deploy start");
    expect(result.verdict).toBe("write");
    expect(result.invocations).toEqual([{ subcommand: "project deploy start", verdict: "write" }]);
  });

  it("recognizes sf by basename when invoked with an absolute path", () => {
    const result = classifyExecCommand("/usr/local/bin/sf org list");
    expect(result.verdict).toBe("denied");
    expect(result.invocations).toEqual([
      { subcommand: "org list", verdict: "denied", reason: SF_POLICY_TABLE.denied["org list"] },
    ]);
  });

  it("finds no invocation when sf only appears as an argument", () => {
    expect(classifyExecCommand("echo sf")).toEqual({ invocations: [], verdict: "none" });
  });

  it("aggregates chained invocations to the highest-precedence verdict", () => {
    const result = classifyExecCommand("sf help; sf apex run --file x.apex");
    expect(result.verdict).toBe("write");
    expect(result.invocations).toEqual([
      { subcommand: "help", verdict: "read" },
      { subcommand: "apex run", verdict: "write" },
    ]);
  });

  it("denies every sfdx invocation regardless of subcommand, always with reason use sf", () => {
    expect(classifyExecCommand("sfdx force:org:display").invocations).toEqual([
      { subcommand: "org display", verdict: "denied", reason: "use sf" },
    ]);
    expect(classifyExecCommand("sfdx force:data:soql:query").invocations).toEqual([
      { subcommand: "data soql query", verdict: "denied", reason: "use sf" },
    ]);
  });

  it("skips wrapper commands to find the real invocation", () => {
    const result = classifyExecCommand("env FOO=bar nohup sudo time sf data query -q x");
    expect(result.invocations).toEqual([{ subcommand: "data query", verdict: "read" }]);
  });

  it("prefers denied over write and read in the overall verdict", () => {
    const result = classifyExecCommand("sf org display; sf project deploy start; sf help");
    expect(result.verdict).toBe("denied");
  });
});

describe("createExecPolicyHook", () => {
  const config = buildConfig({ "profile-joe": ADMIN, "profile-ada": MEMBER });
  const hook = createExecPolicyHook({ config });

  function run(command: unknown, senderId: string | undefined) {
    return hook(
      { toolName: "exec", params: { command } },
      { toolName: "exec", requester: senderId ? { senderId } : undefined },
    );
  }

  it("blocks when the run has no requester at all", () => {
    expect(run("sf data query -q 'SELECT Id FROM Account'", undefined)).toEqual({
      block: true,
      blockReason:
        "Salesforce commands run as the person asking, and this run has no Henry-provisioned requester.",
    });
  });

  it("blocks when the requester is not a Henry-configured person", () => {
    expect(run("sf data query -q 'SELECT Id FROM Account'", "profile-unknown")).toEqual({
      block: true,
      blockReason:
        "Salesforce commands run as the person asking, and this run has no Henry-provisioned requester.",
    });
  });

  it("passes a read command for a member", () => {
    expect(run("sf data query -q 'SELECT Id FROM Account'", "profile-ada")).toBeUndefined();
  });

  it("blocks a write command for a member with the draft-and-escalate wording", () => {
    expect(run("sf project deploy start", "profile-ada")).toEqual({
      block: true,
      blockReason:
        "sf project deploy start changes Salesforce and needs an admin. Draft the exact command and ask Joe to run it.",
    });
  });

  it("passes a write command for the admin", () => {
    expect(run("sf project deploy start", "profile-joe")).toBeUndefined();
  });

  it("blocks org display for the admin too", () => {
    expect(run("sf org display", "profile-joe")).toEqual({
      block: true,
      blockReason: `sf org display is disabled here: ${SF_POLICY_TABLE.denied["org display"]}.`,
    });
  });

  it("passes through a non-string command", () => {
    expect(run({ not: "a string" }, "profile-ada")).toBeUndefined();
  });

  it("passes through a command with no sf or sfdx invocation, even without a requester", () => {
    expect(run("echo hello", undefined)).toBeUndefined();
  });
});

describe("classifySfArgv denies credential-exposing subcommands by prefix", () => {
  it.each([
    [["org", "login", "jwt", "--username", "x"], "org login jwt"],
    [["org", "login", "web"], "org login web"],
    [["org", "logout", "--all"], "org logout"],
    [["auth", "list"], "auth list"],
    [["auth", "accesstoken", "store"], "auth accesstoken store"],
    [["org", "open", "--url-only"], "org open"],
    [["org", "display", "--verbose"], "org display"],
  ])("denies %j", (argv, subcommand) => {
    expect(classifySfArgv(argv)).toMatchObject({ subcommand, verdict: "denied" });
  });

  it("keeps read entries under a denied prefix readable", () => {
    expect(classifySfArgv(["org", "list", "metadata", "--json"])).toMatchObject({
      subcommand: "org list metadata",
      verdict: "read",
    });
    expect(classifySfArgv(["org", "list", "limits"])).toMatchObject({ verdict: "read" });
    expect(classifySfArgv(["org", "list"])).toMatchObject({ verdict: "denied" });
  });

  it("classifies a bare sf as read", () => {
    expect(classifySfArgv([])).toMatchObject({ subcommand: "", verdict: "read" });
    expect(classifySfArgv(["--json"])).toMatchObject({ subcommand: "", verdict: "read" });
  });
});
