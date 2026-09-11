import { describe, expect, it, vi } from "vitest";
import type { HenryDb, PersonRow } from "./db.js";
import type { DecisionLogger, DecisionLogEntry } from "./logger.js";
import { createPolicyHook, normalizeToolName } from "./policy-hook.js";
import { buildSafeServerNameMap } from "./safe-names.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(overrides?: Partial<HenryDb>): HenryDb & { getPerson: ReturnType<typeof vi.fn> } {
  return {
    getPerson: vi.fn(() => Promise.resolve(null)),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function makeLogger(): DecisionLogger & { calls: DecisionLogEntry[] } {
  const calls: DecisionLogEntry[] = [];
  return {
    calls,
    log(entry: DecisionLogEntry) {
      calls.push(entry);
    },
  };
}

function makePerson(overrides?: Partial<PersonRow>): PersonRow {
  return {
    profileId: "prof-1",
    email: "user@example.com",
    displayName: "Test User",
    role: "member",
    access: {
      defaultVerdict: "deny",
      rules: [{ glob: "read", verdict: "allow" }],
    },
    ...overrides,
  };
}

const DEFAULT_PARAMS = {
  db: makeDb(),
  logger: makeLogger(),
  globalDefaultVerdict: "deny" as const,
  passthroughNoPrincipal: true,
  mcpServerNameMap: buildSafeServerNameMap([]),
};

// ---------------------------------------------------------------------------
// normalizeToolName
// ---------------------------------------------------------------------------

describe("normalizeToolName", () => {
  it("known server prefix rewrites to mcp:<configKey>:<tool>", () => {
    // safeName "monday" → configKey "monday"; no difference after sanitization
    const map = buildSafeServerNameMap(["monday"]);
    expect(normalizeToolName("monday__create_item", map)).toBe("mcp:monday:create_item");
  });

  it("unknown server prefix passes through unchanged", () => {
    const map = buildSafeServerNameMap(["monday"]);
    expect(normalizeToolName("other__tool", map)).toBe("other__tool");
  });

  it("tool name containing further __ in the tool part is preserved", () => {
    // The separator is only the first `<server>__`; rest passes through verbatim
    const map = buildSafeServerNameMap(["monday"]);
    expect(normalizeToolName("monday__some__nested", map)).toBe("mcp:monday:some__nested");
  });

  it("longest-prefix disambiguation: ['mon', 'mon__day'] with 'mon__day__do_thing'", () => {
    // "mon__day__do_thing" — both "mon" and "mon__day" are prefixes when we check `<name>__`
    // "mon" → prefix is "mon__", rest is "day__do_thing"
    // "mon__day" → prefix is "mon__day__", rest is "do_thing"
    // longest name wins: "mon__day"
    const map = buildSafeServerNameMap(["mon", "mon__day"]);
    expect(normalizeToolName("mon__day__do_thing", map)).toBe("mcp:mon__day:do_thing");
  });

  it("empty server map passes through unchanged", () => {
    const map = buildSafeServerNameMap([]);
    expect(normalizeToolName("monday__create_item", map)).toBe("monday__create_item");
  });

  it("built-in tool name with no __ passes through", () => {
    const map = buildSafeServerNameMap(["monday"]);
    expect(normalizeToolName("exec", map)).toBe("exec");
  });

  it("already-canonical mcp: form passes through unchanged when not in server map", () => {
    const map = buildSafeServerNameMap(["monday"]);
    expect(normalizeToolName("mcp:monday:create_item", map)).toBe("mcp:monday:create_item");
  });

  it("configKey differs from safeName: toolName uses safeName, DSL uses configKey", () => {
    // configKey "my.monday" sanitizes to safeName "my-monday"
    // event.toolName arrives as "my-monday__create" (safe form from the model)
    // normalizer must return "mcp:my.monday:create" (original configKey in the DSL name)
    const map = buildSafeServerNameMap(["my.monday"]);
    expect(normalizeToolName("my-monday__create", map)).toBe("mcp:my.monday:create");
  });
});

// ---------------------------------------------------------------------------
// createPolicyHook — main 13 cases from the plan
// ---------------------------------------------------------------------------

describe("createPolicyHook", () => {
  // 1. No senderId + passthroughNoPrincipal: true → undefined; nothing logged
  it("no senderId + passthroughNoPrincipal: true → undefined; nothing logged", async () => {
    const logger = makeLogger();
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, logger, passthroughNoPrincipal: true });
    const result = await hook({ toolName: "read", params: {} }, {});
    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(0);
  });

  // 2. No senderId + passthroughNoPrincipal: false → block; logged block_no_principal
  it("no senderId + passthroughNoPrincipal: false → block with log", async () => {
    const logger = makeLogger();
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, logger, passthroughNoPrincipal: false });
    const result = await hook({ toolName: "read", params: {} }, {});
    expect(result).toMatchObject({ block: true });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.verdict).toBe("block_no_principal");
    expect(logger.calls[0]?.profileId).toBeNull();
  });

  // 3. senderId present, db.getPerson returns null → block_not_provisioned logged; block returned
  it("db.getPerson returns null → block_not_provisioned", async () => {
    const logger = makeLogger();
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(null)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "read", params: {} },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("not provisioned"),
    });
    expect(logger.calls[0]?.verdict).toBe("block_not_provisioned");
  });

  // 4. db.getPerson throws → block returned; nothing logged
  it("db.getPerson throws → fail-closed block; nothing logged", async () => {
    const logger = makeLogger();
    const db = makeDb({ getPerson: vi.fn(() => Promise.reject(new Error("db down"))) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "read", params: {} },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toMatchObject({
      block: true,
      blockReason: "Policy check unavailable. Try again shortly.",
    });
    expect(logger.calls).toHaveLength(0);
  });

  // 5. Person with allow rule matching tool → undefined; allow logged
  it("allow rule → undefined; allow logged", async () => {
    const logger = makeLogger();
    const person = makePerson({
      access: { defaultVerdict: "deny", rules: [{ glob: "read", verdict: "allow" }] },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "read", params: {} },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toBeUndefined();
    expect(logger.calls[0]?.verdict).toBe("allow");
    expect(logger.calls[0]?.tool).toBe("read");
  });

  // 6. Person with deny default, tool not in rules → block with draft-and-escalate; deny logged
  it("deny default, tool not in rules → block with escalation wording; deny logged", async () => {
    const logger = makeLogger();
    const person = makePerson({
      access: { defaultVerdict: "deny", rules: [] },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: {} },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toMatchObject({ block: true });
    const blockResult = result as { block: true; blockReason: string };
    expect(blockResult.blockReason).toContain("exec");
    expect(blockResult.blockReason).toContain("ask Joe");
    expect(logger.calls[0]?.verdict).toBe("deny");
  });

  // 7. approval rule → requireApproval returned with correct title and timeout; approval logged
  it("approval rule → requireApproval with correct title and 5-min timeout", async () => {
    const logger = makeLogger();
    const person = makePerson({
      displayName: "Nikki",
      email: "nikki@example.com",
      access: {
        defaultVerdict: "deny",
        rules: [{ glob: "mcp:monday:*", verdict: "approval" }],
      },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({
      ...DEFAULT_PARAMS,
      db,
      logger,
      mcpServerNameMap: buildSafeServerNameMap(["monday"]),
    });
    const result = await hook(
      { toolName: "monday__create_item", params: { boardId: "123" } },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toBeDefined();
    const approval = (
      result as {
        requireApproval: { title: string; timeoutMs: number; allowedDecisions: string[] };
      }
    ).requireApproval;
    expect(approval.title).toBe("Approve: monday__create_item");
    expect(approval.timeoutMs).toBe(300_000);
    expect(approval.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(logger.calls[0]?.verdict).toBe("approval");
  });

  // 8. onResolution("allow-once") → log with verdict: "allow" reason "approval:allow-once"
  it("onResolution('allow-once') → log allow with approval:allow-once reason", async () => {
    const logger = makeLogger();
    const person = makePerson({
      access: { defaultVerdict: "deny", rules: [{ glob: "exec", verdict: "approval" }] },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: {} },
      { requester: { senderId: "user-1" } },
    );
    const approval = (result as { requireApproval: { onResolution: (d: string) => Promise<void> } })
      .requireApproval;
    await approval.onResolution("allow-once");
    const lastLog = logger.calls[logger.calls.length - 1]!;
    expect(lastLog.verdict).toBe("allow");
    expect(lastLog.reason).toBe("approval:allow-once");
  });

  // 9. onResolution("deny") → log with verdict: "deny" reason "approval:deny"
  it("onResolution('deny') → log deny with approval:deny reason", async () => {
    const logger = makeLogger();
    const person = makePerson({
      access: { defaultVerdict: "deny", rules: [{ glob: "exec", verdict: "approval" }] },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: {} },
      { requester: { senderId: "user-1" } },
    );
    const approval = (result as { requireApproval: { onResolution: (d: string) => Promise<void> } })
      .requireApproval;
    await approval.onResolution("deny");
    const lastLog = logger.calls[logger.calls.length - 1]!;
    expect(lastLog.verdict).toBe("deny");
    expect(lastLog.reason).toBe("approval:deny");
  });

  // 10. shortParamSummary redacts a long base64-looking string in params
  it("approval description redacts long base64-like value in params", async () => {
    const logger = makeLogger();
    const person = makePerson({
      access: { defaultVerdict: "deny", rules: [{ glob: "exec", verdict: "approval" }] },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const longToken = "A".repeat(50);
    const result = await hook(
      { toolName: "exec", params: { token: longToken } },
      { requester: { senderId: "user-1" } },
    );
    const approval = (result as { requireApproval: { description: string } }).requireApproval;
    expect(approval.description).not.toContain(longToken);
    expect(approval.description).toContain("[redacted]");
  });

  // 11. exec tool blocked for member whose access denies exec
  it("exec denied for member with exec:deny rule", async () => {
    const logger = makeLogger();
    const person = makePerson({
      role: "member",
      access: {
        defaultVerdict: "deny",
        rules: [{ glob: "exec", verdict: "deny" }],
      },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: {} },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toMatchObject({ block: true });
    expect(logger.calls[0]?.verdict).toBe("deny");
  });

  // 12. mcp:monday:create_item allowed for member with mcp:monday:* → allow
  it("mcp:monday:create_item allowed via mcp:monday:* → allow rule", async () => {
    const logger = makeLogger();
    const person = makePerson({
      role: "member",
      access: {
        defaultVerdict: "deny",
        rules: [{ glob: "mcp:monday:*", verdict: "allow" }],
      },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({
      ...DEFAULT_PARAMS,
      db,
      logger,
      mcpServerNameMap: buildSafeServerNameMap(["monday"]),
    });
    const result = await hook(
      { toolName: "monday__create_item", params: {} },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toBeUndefined();
    expect(logger.calls[0]?.verdict).toBe("allow");
    expect(logger.calls[0]?.tool).toBe("mcp:monday:create_item");
  });

  // 13. DB is async: handler awaits db.getPerson before returning
  it("handler awaits db.getPerson (async db)", async () => {
    const logger = makeLogger();
    let resolve!: (p: PersonRow | null) => void;
    const pending = new Promise<PersonRow | null>((res) => {
      resolve = res;
    });
    const db = makeDb({ getPerson: vi.fn(() => pending) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });

    const resultPromise = hook({ toolName: "read", params: {} }, { requester: { senderId: "u1" } });

    // Not yet resolved
    expect(logger.calls).toHaveLength(0);

    resolve(null);
    const result = await resultPromise;
    expect(result).toMatchObject({ block: true });
    expect(logger.calls[0]?.verdict).toBe("block_not_provisioned");
  });
});

// ---------------------------------------------------------------------------
// exec-classifier integration in createPolicyHook
// ---------------------------------------------------------------------------

describe("createPolicyHook — exec:sf classifier integration", () => {
  // Helpers — person with exec:sf allow and exec approval rules (member template)
  function makeMemberWithExecSf(): PersonRow {
    return makePerson({
      role: "member",
      access: {
        defaultVerdict: "deny",
        rules: [
          { glob: "exec:sf", verdict: "allow" },
          { glob: "exec", verdict: "approval" },
        ],
      },
    });
  }

  // 14. Pure-sf command + exec:sf allow rule → allow; logged as exec:sf
  it("pure-sf command with exec:sf allow → allow; tool logged as exec:sf", async () => {
    const logger = makeLogger();
    const person = makeMemberWithExecSf();
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: { command: "sf data query -q 'SELECT Id FROM Account'" } },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toBeUndefined();
    expect(logger.calls[0]?.verdict).toBe("allow");
    expect(logger.calls[0]?.tool).toBe("exec:sf");
  });

  // 15. Generic command (pipe) + exec approval rule → requireApproval; logged as exec
  it("generic command (pipe) → approval path; tool logged as exec", async () => {
    const logger = makeLogger();
    const person = makeMemberWithExecSf();
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: { command: "sf org list metadata | head" } },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toBeDefined();
    const approval = (result as { requireApproval: { title: string; allowedDecisions: string[] } })
      .requireApproval;
    expect(approval).toBeDefined();
    expect(logger.calls[0]?.verdict).toBe("approval");
    expect(logger.calls[0]?.tool).toBe("exec");
  });

  // 16. Pure-sf command but no exec:sf rule → falls back to exec rule → approval
  it("pure-sf command, no exec:sf rule → falls back to exec rule verdict", async () => {
    const logger = makeLogger();
    const person = makePerson({
      role: "member",
      access: {
        defaultVerdict: "deny",
        rules: [{ glob: "exec", verdict: "approval" }],
      },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: { command: "sf data query -q x" } },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toBeDefined();
    const approval = (result as { requireApproval: { title: string; allowedDecisions: string[] } })
      .requireApproval;
    expect(approval).toBeDefined();
    // Falls back to exec rule, so tool is logged as exec
    expect(logger.calls[0]?.tool).toBe("exec");
    expect(logger.calls[0]?.verdict).toBe("approval");
  });

  // 17. Generic shell command (rm) + exec deny rule → block; logged as exec
  it("generic shell command with exec deny → block; tool logged as exec", async () => {
    const logger = makeLogger();
    const person = makePerson({
      role: "member",
      access: {
        defaultVerdict: "deny",
        rules: [
          { glob: "exec:sf", verdict: "allow" },
          { glob: "exec", verdict: "deny" },
        ],
      },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: { command: "rm -rf /tmp/x" } },
      { requester: { senderId: "user-1" } },
    );
    expect(result).toMatchObject({ block: true });
    expect(logger.calls[0]?.verdict).toBe("deny");
    expect(logger.calls[0]?.tool).toBe("exec");
  });

  // 18. Non-string command param → treated as generic exec → uses exec rule
  it("non-string command param → plain exec rule applies", async () => {
    const logger = makeLogger();
    const person = makeMemberWithExecSf();
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: { command: 42 } },
      { requester: { senderId: "user-1" } },
    );
    // exec:sf allow wouldn't help; exec approval is the rule
    const approval = (result as { requireApproval: { title: string } }).requireApproval;
    expect(approval).toBeDefined();
    expect(logger.calls[0]?.tool).toBe("exec");
  });

  // 19. exec:sf allow + onResolution approval callback logs exec:sf
  it("exec:sf approval onResolution logs exec:sf", async () => {
    const logger = makeLogger();
    const person = makePerson({
      role: "member",
      access: {
        defaultVerdict: "deny",
        rules: [{ glob: "exec:sf", verdict: "approval" }],
      },
    });
    const db = makeDb({ getPerson: vi.fn(() => Promise.resolve(person)) });
    const hook = createPolicyHook({ ...DEFAULT_PARAMS, db, logger });
    const result = await hook(
      { toolName: "exec", params: { command: "sf data query -q x" } },
      { requester: { senderId: "user-1" } },
    );
    const approval = (result as { requireApproval: { onResolution: (d: string) => Promise<void> } })
      .requireApproval;
    await approval.onResolution("allow-once");
    const lastLog = logger.calls[logger.calls.length - 1]!;
    expect(lastLog.tool).toBe("exec:sf");
    expect(lastLog.reason).toBe("approval:allow-once");
  });
});
