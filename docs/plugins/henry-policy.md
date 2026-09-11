---
summary: "Gate every tool call against a Postgres-backed per-person access policy, with no shared credential"
read_when:
  - You want to restrict which tools each Henry user can invoke
  - You are seeding or updating a person's access rules in henry_people
  - You are auditing tool-call decisions in henry_policy_decisions
  - You are configuring the Postgres DSN, cache TTL, or default verdict
title: "Henry Policy plugin"
---

# Henry Policy plugin

Henry-policy gates every tool call an agent makes against the requesting
person's `henry_people.access` JSONB before the tool executes. Unknown
requesters are blocked; tools not listed in a person's access rules fall to
the configured default verdict. Sensitive-but-allowed calls can be routed to
the connected operator for approval, and every decision is logged to
`henry_policy_decisions` for audit.

## How it works

```
person's turn (profile id in SenderId, Plan 1 patch)
  → model chooses a tool
  → before_tool_call (henry-policy, priority 90, all tools):
        1. ctx.requester?.senderId absent → pass through (automated runs)
        2. cache lookup by profileId, TTL 60 s → henry_people row
           cache miss → psql SELECT in worker thread (off the hot path)
           no henry_people row → block("not provisioned")
        3. tool name → safe-name normalization (__ separator → mcp:<key>:<tool>)
           → glob-match against access.rules[] in priority order
           no match → apply access.defaultVerdict (default "deny")
        4. verdict "allow" → undefined (pass)
           verdict "deny" → block with draft-and-escalate wording
           verdict "approval" → requireApproval routed to connected operator
        5. log verdict to henry_policy_decisions (async, fire-and-forget)
  → henry-sf before_tool_call hook (priority 100, exec only) already ran
     (higher number = higher priority; henry-sf gates sf writes first)
  → tool executes
```

**DSN resolution** is lazy: the pool is created on the first tool call, not at
Gateway startup, so an unreachable Postgres at startup does not prevent the
Gateway from loading. If resolution fails, the hook fails closed and retries
after 30 seconds; within that window every tool call for a provisioned person
is blocked until the database is reachable again.

**Pool singleton:** `register()` can run more than once per process (duplicate
discovery roots). The pool is a module-scope singleton keyed by resolved DSN
string; two identical configurations share one pool rather than opening
duplicate connections.

## Configuration

Set config under `plugins.entries.henry-policy.config`. The `db.dsn` field
accepts a plain connection string or a
[SecretRef](/gateway/secrets):

```json5
{
  plugins: {
    entries: {
      "henry-policy": {
        enabled: true,
        config: {
          db: {
            dsn: { source: "file", provider: "default", id: "henry-policy-dsn" },
          },
          cacheTtlSeconds: 60,
          defaultVerdict: "deny",
        },
      },
    },
  },
}
```

The `provider` name above must match a named entry in your
`secrets.providers` file-provider config. The `id` field is the key inside
that provider; the resolved value is the Postgres connection string (for
example `postgres://henry:…@localhost:5432/henry`). See
[Secrets](/gateway/secrets) for all SecretRef source types (`env`, `file`,
`exec`, `store`).

| Config key               | Type                  | Default      | Notes                                                   |
| ------------------------ | --------------------- | ------------ | ------------------------------------------------------- |
| `db.dsn`                 | string \| SecretRef   | — (required) | Postgres connection string                              |
| `db.poolMax`             | integer 1–10          | `2`          | Max pool connections                                    |
| `cacheTtlSeconds`        | integer 0–600         | `60`         | Per-person cache TTL; 0 disables                        |
| `defaultVerdict`         | `"allow"` \| `"deny"` | `"deny"`     | Verdict when no rule matches                            |
| `passthroughNoPrincipal` | boolean               | `true`       | Pass through automated runs (cron, heartbeat, subagent) |

## Schema

Run `extensions/henry-policy/src/seed.sql` once on the `henry` Postgres
database. The file is idempotent (`CREATE TABLE IF NOT EXISTS`) and includes
Joe's seed row. Member rows ship commented out; fill the `profile_id` values
from `openclaw users list` after each person's first Access login, then
uncomment and run.

```sql
CREATE TABLE IF NOT EXISTS henry_people (
    profile_id    text        PRIMARY KEY,
    email         text        UNIQUE NOT NULL,
    display_name  text,
    role          text        NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
    sf_username_gtmops text,
    sf_username_prod   text,
    access        jsonb       NOT NULL DEFAULT '{}',
    context_md    text,
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS henry_policy_decisions (
    id            bigserial   PRIMARY KEY,
    at            timestamptz DEFAULT now(),
    profile_id    text,
    tool          text        NOT NULL,
    params_digest text,
    verdict       text        NOT NULL CHECK (verdict IN ('allow', 'deny', 'approval', 'block_no_principal', 'block_not_provisioned')),
    reason        text
);

CREATE INDEX IF NOT EXISTS henry_policy_decisions_at
    ON henry_policy_decisions (at DESC);
CREATE INDEX IF NOT EXISTS henry_policy_decisions_profile
    ON henry_policy_decisions (profile_id, at DESC);
```

The `params_digest` column stores a 16-character truncated SHA-256 hex digest
of the serialized params — never the params themselves, which may contain
secrets.

## Access JSONB DSL

Each `henry_people` row carries an `access` JSONB column:

```json
{
  "defaultVerdict": "deny",
  "rules": [
    { "glob": "read", "verdict": "allow" },
    { "glob": "web_fetch", "verdict": "allow" },
    { "glob": "web_search", "verdict": "allow" },
    { "glob": "memory_search", "verdict": "allow" },
    { "glob": "session_status", "verdict": "allow" },
    { "glob": "mcp:monday:*", "verdict": "allow" },
    { "glob": "exec:sf", "verdict": "allow" },
    { "glob": "exec", "verdict": "approval" }
  ]
}
```

**Semantics:**

- `rules` is an ordered array; the **first matching rule wins** (most-specific
  first is idiomatic).
- `glob` matches against the canonical tool name after normalization (see
  below). `*` matches any sequence of characters that does not contain `:`.
  Use `mcp:<serverName>:*` to match all tools on a server.
- `verdict` is one of `allow`, `deny`, or `approval`.
- `defaultVerdict` is `allow` or `deny`; absent → `deny` (fail closed). It
  cannot be `approval` — an access policy without explicit rules cannot
  require approval for unknown tools.
- An empty `access` object (`{}`) or a missing column → `defaultVerdict` →
  all tools blocked by default.

**Wire names vs config keys:** MCP tools arrive at `before_tool_call` as
`<safeName>__<toolName>` where `safeName` is the sanitized model-facing server
name (non-alphanumeric characters replaced with `-`, truncated to 30 chars).
Henry-policy maps safe names back to their original config keys using
`buildSafeServerNameMap`, then normalizes to `mcp:<configKey>:<toolName>`
before glob matching. Write globs against config keys (e.g.
`mcp:monday:change_item_column_values`), not sanitized safe names.

### The exec:sf pseudo-tool

When the tool name is `exec` and the `command` parameter is a string,
henry-policy runs it through the **exec classifier** before evaluating access
rules. The classifier returns one of two values:

- **`pure-sf`** — every invocation in the command is the `sf` CLI (env-prefix
  and wrapper words like `env`/`sudo` are stripped; absolute paths whose
  basename is `sf` are recognized). Multiple `sf` commands chained with `;` or
  `&&` also qualify.
- **`generic`** — anything else: a non-sf invocation, a pipe (`|` or `||`), a
  redirection (`>`, `>>`, `<`), a command substitution (`$(…)` or backtick), or
  a subshell (`(…)`). Empty or whitespace-only input is also `generic`.

When the result is `pure-sf`, henry-policy evaluates the **pseudo-tool name
`exec:sf`** against the person's access rules first:

- If a rule explicitly matches `exec:sf`, that verdict is used and the decision
  is logged with `tool = "exec:sf"`.
- If no rule matches `exec:sf` (only the `defaultVerdict` would apply), the
  hook falls back to evaluating plain `exec` — so configs without an `exec:sf`
  rule behave exactly as before.

When the result is `generic`, plain `exec` is evaluated unconditionally.

**Fail-closed stance:** The classifier is intentionally strict. Any shell
construct that could run an arbitrary second command causes the whole command to
be classified as `generic`. In particular, `sf … | head` is `generic` (members
should let Henry post-process sf output rather than piping it). This is the
accepted tradeoff for security: a false-negative (classifying a non-sf command
as `pure-sf`) is far more dangerous than a false-positive (classifying a safe
pipe as `generic` and routing it to the `exec` approval flow).

**Henry-sf still governs read vs. write inside sf:** The exec classifier in
henry-policy only decides _which policy rule to apply_. Henry-sf at priority 100
still enforces the `sf` read-vs-write policy and denies credential-exposing
subcommands regardless of what henry-policy allows.

## Interaction with henry-sf

| Priority | Plugin       | Matcher   | Result                                                                    |
| -------- | ------------ | --------- | ------------------------------------------------------------------------- |
| 100      | henry-sf     | `exec`    | Classifies `sf` commands; blocks member writes; blocks denied subcommands |
| 90       | henry-policy | all tools | Checks access JSONB; blocks unlisted tools; gates approvals               |

Henry-sf (priority 100) runs **before** henry-policy (priority 90) for `exec`
calls. A block from henry-sf at priority 100 terminates the chain —
henry-policy never sees that call. Henry-policy can still block admin `exec`
calls for tools not in their access rules.

**Adopted decision — members and exec:** The seed data ships with
`exec:sf → allow` and `exec → approval` for members. The `exec:sf` rule lets
members run pure-`sf` commands (e.g. `sf data query …`) without interrupting
Joe, while arbitrary shell via the `exec` tool is routed through the approval
flow. Henry-sf at priority 100 continues to enforce the Salesforce read-vs-write
policy within those allowed sf commands — the two layers are additive, not
competing.

## Fail-closed warn behavior

When henry-policy fails closed it now emits a rate-limited `console.warn` so
the journal surfaces the failure without flooding logs on repeated tool calls:

- **DSN resolution failure** — emitted when the Postgres DSN cannot be resolved
  (either on first attempt or on re-attempt after the 30-second retry window).
  Rate limited to once per 60 seconds. Message: `[henry-policy] DSN resolution
failed; policy checks fail-closed (retrying after 30s)`.
- **`db.getPerson` failure** — emitted when the database query itself throws
  after pool creation succeeds (e.g. a transient query error). Rate limited to
  once per 60 seconds. Message: `[henry-policy] db.getPerson failed; policy
check fail-closed`.

The warn messages name the failure class only — they never include the DSN
string, connection parameters, or any request data.

## Trust model and known limits

Guaranteed by this plugin:

- An unknown requester (no `henry_people` row) is always blocked.
- An empty or absent `access` JSONB defaults to `deny` for all tools.
- A DSN resolution failure at cache-miss time fails closed: the hook blocks
  and retries after 30 seconds without requiring a Gateway restart.
- The 60-second cache means a person's access rules are refreshed at most once
  per minute. An emergency revoke (removing a person's row) takes effect
  within 60 seconds without a restart.
- The `params_digest` logged to `henry_policy_decisions` never contains the
  actual params, only a truncated hash.
- Cron, heartbeat, and subagent runs are explicitly passed through (no
  principal → no gate), not accidentally allowed. Set
  `passthroughNoPrincipal: false` to block automated runs instead.
- The pool is a module-scope singleton keyed by resolved DSN so duplicate
  `register()` calls share one connection pool.
- The exec classifier is fail-closed: any shell construct that could run an
  arbitrary non-sf command causes the command to be classified as `generic`,
  never as `pure-sf`. A `generic` classification cannot grant more access than
  the plain `exec` rule allows.

Not guaranteed, stated plainly:

- Henry-policy is a Henry layer. OpenClaw's own `tools.toolsBySender` config
  entries (keyed `id:<profileId>`) can override tool access outside this
  plugin. Those entries should be kept minimal and consistent with
  henry-policy.
- The cache means a compromised or revoked person can still call allowed tools
  for up to 60 seconds after their row is removed. Postgres must be reachable
  for the cache to refresh; a sustained Postgres outage means the cache
  eventually goes cold and all calls fail closed.
- Cron and heartbeat runs bypass henry-policy by design. The agent's own
  credentials and OpenClaw's role system govern those runs.
- `requireApproval` is surfaced to any connected operator with
  `operator.approvals` scope, not specifically Joe, unless scope
  configuration is tightened.

## Seed

See `extensions/henry-policy/src/seed.sql` for the full DDL and per-person
seed stubs. Profile IDs for the three members are placeholders; fill them
from `openclaw users list` after each person's first Cloudflare Access login.

## Related

- [Plugin hooks](/plugins/hooks) - the `before_tool_call` hook this plugin
  registers
- [Secrets](/gateway/secrets) - SecretRef sources accepted by `db.dsn`
- [henry-sf](/plugins/henry-sf) - the complementary Salesforce credential
  plugin that runs at higher priority
