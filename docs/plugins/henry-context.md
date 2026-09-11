---
summary: "Inject per-person and team context into every Henry turn; persist per-person session memory to Postgres"
read_when:
  - You want to enable per-person context injection for Henry sessions
  - You are seeding or updating henry_team_context or henry_people context_md
  - You are diagnosing why context is missing or stale on a turn
  - You are configuring the DSN, TTLs, token budgets, or memory flush settings
  - You need to invalidate the team or speaker cache without restarting the Gateway
title: "Henry Context plugin"
---

# Henry Context plugin

Henry-context injects two tiers of context into every Henry turn: a team-level
background block loaded from `henry_team_context`, and a per-person block loaded
from `henry_people` plus recent `henry_memory` rows. At session end it writes a
heuristic summary of the session back to `henry_memory`, so future sessions for
the same person start with accumulated context.

## How it works

```
person's turn (profile id in ctx.senderId, Plan 1)
  → before_prompt_build (henry-context, priority 80):
       (a) team tier — load henry_team_context.content_md from cache (TTL 10 min)
       (b) speaker tier — load henry_people row for ctx.senderId from cache (TTL 5 min)
                          load recent henry_memory rows for that profile_id (last N items)
       return { prependSystemContext: <assembled block> }
  → model runs with full speaker + team context in system prompt
  → agent_end (henry-context):
       if event.senderId is present and session produced meaningful output:
         produce heuristic summary (last 3 assistant turn excerpts)
         write summary → henry_memory row (kind="session")
         on Postgres failure → append to MEMORY.md fallback
```

The `ctx.senderId` is the verified OpenClaw profile UUID provided by Plan 1's
core patch. Display-name matching is never used.

### Injection block format

```
--- Henry Context ---
## Team
<henry_team_context.content_md>

## You
Name: <henry_people.display_name>
Role: <henry_people.role>
<henry_people.context_md>

## Your recent memory
- <henry_memory item, most recent first>
--- End Henry Context ---
```

The block is returned as `prependSystemContext` so it appears before the agent's
own `AGENTS.md` and `MEMORY.md` content in the assembled system prompt.

## Fail-safes

Two invariants govern the design:

1. **A failed Postgres read never blocks a turn.** On any DB error, the plugin
   degrades gracefully: stale cached data is returned if within `staleTtlMs`;
   otherwise the tier is absent and the turn continues without injection.
   The hook NEVER throws and NEVER returns a block-verdict — only
   `prependSystemContext` or `undefined`.
2. **A failed memory flush never permanently loses data.** On Postgres write
   failure, the summary is appended to the agent's shared `MEMORY.md` daily
   note with an owner-attributed prefix
   (`- [henry-context] <date> <profileId>: <summary>`). If that also fails,
   the result is logged at error and the session ends cleanly.

DSN resolution is lazy: the pool is created on the first hook invocation, not at
Gateway startup. A missing Postgres at startup does not prevent the Gateway from
loading. On DSN resolution failure the hook returns `undefined` (no injection)
and retries after 30 seconds. The pool is a module-scope singleton keyed by
resolved DSN string, so duplicate `register()` calls share one pool.

## Database prerequisites

Run these DDL statements once on the `henry` Postgres database before enabling
the plugin. They are idempotent (`CREATE TABLE IF NOT EXISTS`).

```sql
CREATE TABLE IF NOT EXISTS henry_team_context (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content_md  TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS henry_memory (
  id             BIGSERIAL   PRIMARY KEY,
  profile_id     TEXT        NOT NULL,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind           TEXT        NOT NULL DEFAULT 'session',
  content        TEXT        NOT NULL,
  source_session TEXT,
  FOREIGN KEY (profile_id) REFERENCES henry_people(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS henry_memory_profile_at
  ON henry_memory (profile_id, at DESC);
```

`henry_team_context` enforces exactly one row (the `CHECK (id = 1)` constraint).
`henry_people` is created by the henry-policy plugin (Plan 4 prerequisite).

## Team context setup

After the schema is seeded, populate `henry_team_context.content_md` with the
shared team background before enabling the plugin:

```sql
INSERT INTO henry_team_context (id, content_md) VALUES (1, '<your team context>')
ON CONFLICT (id) DO UPDATE SET content_md = excluded.content_md, updated_at = now();
```

The `content_md` field accepts plain markdown text. Joe authors and maintains
this content; the plugin only reads it. Suggested starting content: ISI mission,
product lines, active projects, conventions, and facts Henry should always know.

## Configuration

```json5
{
  plugins: {
    entries: {
      "henry-context": {
        enabled: true,
        hooks: { allowConversationAccess: true, allowPromptInjection: true },
        config: {
          db: {
            dsn: { source: "env", provider: "default", id: "HENRY_PG_URL" },
          },
          teamContextTtlMs: 600000,
          speakerTtlMs: 300000,
          memoryFlushEnabled: true,
        },
      },
    },
  },
}
```

`allowConversationAccess: true` and `allowPromptInjection: true` are required
for `before_prompt_build` and `agent_end` on non-bundled plugins.

| Config key            | Type                | Default                     | Notes                                                               |
| --------------------- | ------------------- | --------------------------- | ------------------------------------------------------------------- |
| `db.dsn`              | string \| SecretRef | — (required)                | Postgres connection string                                          |
| `db.poolMax`          | integer 1–10        | `2`                         | Max pool connections                                                |
| `teamContextTtlMs`    | integer ≥0          | `600000` (10 min)           | Team context cache TTL; 0 disables caching                          |
| `speakerTtlMs`        | integer ≥0          | `300000` (5 min)            | Per-speaker cache TTL                                               |
| `staleTtlMs`          | integer ≥0          | `1800000` (30 min)          | Stale-on-error extended TTL; stale data returned if within window   |
| `teamTokenBudget`     | integer ≥100        | `2000`                      | Max tokens for team context; truncated at line boundary if exceeded |
| `speakerTokenBudget`  | integer ≥100        | `1000`                      | Max tokens for speaker tier; memory items dropped oldest-first      |
| `memoryItemLimit`     | integer ≥1          | `10`                        | Max memory items fetched per speaker                                |
| `memoryFlushEnabled`  | boolean             | `true`                      | Register the `agent_end` flush hook                                 |
| `invalidateRoutePath` | string              | `/henry/context/invalidate` | Override the cache-invalidate route path                            |

## Cache-invalidate route

To clear the in-process cache without restarting the Gateway, POST to the
invalidate route from loopback. The route is loopback-only and rejects proxied
requests (Cloudflare headers):

```bash
# Invalidate team context (next turn fetches from Postgres)
curl -s -X POST http://127.0.0.1:18789/henry/context/invalidate \
  -H "Content-Type: application/json" \
  -d '{"scope":"team"}'

# Invalidate a specific speaker
curl -s -X POST http://127.0.0.1:18789/henry/context/invalidate \
  -H "Content-Type: application/json" \
  -d '{"scope":"speaker","profileId":"<profile-uuid>"}'

# Invalidate team + a specific speaker in one call
curl -s -X POST http://127.0.0.1:18789/henry/context/invalidate \
  -H "Content-Type: application/json" \
  -d '{"scope":"all","profileId":"<profile-uuid>"}'
```

Body schema: `{ scope: "team" | "speaker" | "all", profileId?: string }`.
`profileId` is required for `scope: "speaker"` to take effect; it is optional
for `scope: "all"` (omitting it invalidates team only).

The route uses the same loopback guard as henry-sf: requests from
non-loopback addresses or carrying `x-forwarded-for`, `cf-connecting-ip`,
`cf-ray`, or `cf-access-jwt-assertion` headers are rejected with 403.

## Privacy statement

**Sessions are shared.** On a shared Henry session, every turn's system prompt
content is visible to the model and, through the transcript, to all session
participants.

- **Team context (tier A):** team-visible by design.
- **Speaker context_md (tier B):** written and maintained by Joe (admin). It
  contains only information appropriate to share within the ISI team: name,
  role, Salesforce username, work domain, tool preferences. No private personal
  information.
- **Per-person memory (henry_memory):** memory items summarize what the person
  discussed in Henry this session. Because the session transcript is already
  shared, these items contain no information beyond what session participants
  can already see. They are injected on that person's future turns only.

**Open questions (Joe's call before production use):**

- Privacy boundary: if two members share a session, Henry's reply is informed
  by the current speaker's memory items. Is that acceptable, or should tier-B
  injection be admin-only?
- Memory retention: how long should `henry_memory` rows persist? Recommend 90
  days (matching OpenClaw's standing-intent expiry convention).

## Related

- [Plugin hooks](/plugins/hooks) - `before_prompt_build` and `agent_end` hooks
- [Secrets](/gateway/secrets) - SecretRef sources accepted by `db.dsn`
- [henry-policy](/plugins/henry-policy) - the complementary per-person tool
  policy gate that shares the same Postgres `henry_people` table
