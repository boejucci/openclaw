-- Henry Policy: initial schema and seed data.
-- Run once on the henry Postgres database (Proxmox).
-- Replace ⚠️ QUESTION(joe) placeholders before running.
-- profile_id values come from: openclaw users list  (run after first Access login)
--
-- NOTE: The sprint-1 draft at scripts/sprint1/henry-schema-draft.sql already
-- created the henry_people and henry_policy_decisions tables (plus indexes) on
-- the live VM as of 2026-09-04/05.  This file is the canonical go-forward copy;
-- it is idempotent (CREATE TABLE IF NOT EXISTS) and safe to re-run.  The draft
-- also seeded Joe's row — ON CONFLICT DO NOTHING guards against duplicate inserts.

-- ── Schema ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS henry_people (
    profile_id    text        PRIMARY KEY,
    email         text        UNIQUE NOT NULL,
    display_name  text,
    role          text        NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
    sf_username_gtmops text,   -- Salesforce GTMOps sandbox username (henry-sf)
    sf_username_prod   text,   -- Salesforce production username (henry-sf)
    access        jsonb       NOT NULL DEFAULT '{}',
    context_md    text,        -- injected by henry-context (Plan 5)
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS henry_policy_decisions (
    id            bigserial   PRIMARY KEY,
    at            timestamptz DEFAULT now(),
    profile_id    text,        -- null for "no principal" blocks
    tool          text        NOT NULL,
    params_digest text,        -- SHA-256 of JSON-serialized params, truncated to 16 hex chars
                               -- NEVER the params themselves — they may contain secrets
    verdict       text        NOT NULL CHECK (verdict IN ('allow', 'deny', 'approval', 'block_no_principal', 'block_not_provisioned')),
    reason        text         -- the matched rule glob or "default", never the block message text
);

CREATE INDEX IF NOT EXISTS henry_policy_decisions_at     ON henry_policy_decisions (at DESC);
CREATE INDEX IF NOT EXISTS henry_policy_decisions_profile ON henry_policy_decisions (profile_id, at DESC);

-- ── Seed ─────────────────────────────────────────────────────────────────────

-- Joe Bucci — admin; full access by default; approval gates on destructive ops
INSERT INTO henry_people (profile_id, email, display_name, role, sf_username_gtmops, sf_username_prod, access)
VALUES (
  '9a63736c-4c7a-4f5f-a1b3-360d204aec18',  -- verified: live state DB, 2026-09-04
  'jbucci@isidefense.com',                  -- verified: Henry profile email (NOT dodsecurity)
  'Joe Bucci',
  'admin',
  'jbucci@dodsecurity.com.gtmops',          -- verified: sf org list, barry-vm
  'jbucci@isidefense.com',                  -- verified: prod-jwt alias username, barry-vm
  '{
    "defaultVerdict": "allow",
    "rules": []
  }'
)
ON CONFLICT (profile_id) DO NOTHING;

-- The three member INSERTs below are COMMENTED OUT on purpose: their profile_id
-- values are QUESTION placeholders until each person's first Access login
-- (openclaw users list) and Joe confirms their access rules. Running them as-is
-- would insert placeholder-text primary keys. Fill values, then uncomment.
-- Nikki — member; Monday read + selective writes; SF read-only via henry-sf
-- INSERT INTO henry_people (profile_id, email, display_name, role, sf_username_gtmops, sf_username_prod, access)
-- VALUES (
--   '⚠️ QUESTION(joe): Nikki''s OpenClaw profile_id (after her first Access login)',
--   'falbright@isidefense.com',               -- verified: Access policy, 2026-09-05
--   'Nikki Albright',
--   'member',
--   '⚠️ QUESTION(joe): Nikki''s GTMOps SF username (or NULL if she does not use SF CLI)',
--   '⚠️ QUESTION(joe): Nikki''s production SF username (or NULL)',
--   '{
--     "defaultVerdict": "deny",
--     "rules": [
--       { "glob": "read",              "verdict": "allow" },
--       { "glob": "web_fetch",         "verdict": "allow" },
--       { "glob": "web_search",        "verdict": "allow" },
--       { "glob": "memory_search",     "verdict": "allow" },
--       { "glob": "session_status",    "verdict": "allow" },
--       { "glob": "mcp:monday:*",      "verdict": "allow" },
--       { "glob": "exec",              "verdict": "deny"  }
--     ]
--   }'
-- );
-- 
-- Daniel — member; same Monday access as Nikki; SF read-only
-- INSERT INTO henry_people (profile_id, email, display_name, role, sf_username_gtmops, sf_username_prod, access)
-- VALUES (
--   '⚠️ QUESTION(joe): Daniel''s OpenClaw profile_id (after his first Access login)',
--   'dearl@isidefense.com',                   -- verified: Access policy, 2026-09-05
--   'Daniel Earl',
--   'member',
--   '⚠️ QUESTION(joe): Daniel''s GTMOps SF username (or NULL)',
--   '⚠️ QUESTION(joe): Daniel''s production SF username (or NULL)',
--   '{
--     "defaultVerdict": "deny",
--     "rules": [
--       { "glob": "read",              "verdict": "allow" },
--       { "glob": "web_fetch",         "verdict": "allow" },
--       { "glob": "web_search",        "verdict": "allow" },
--       { "glob": "memory_search",     "verdict": "allow" },
--       { "glob": "session_status",    "verdict": "allow" },
--       { "glob": "mcp:monday:*",      "verdict": "allow" },
--       { "glob": "exec",              "verdict": "deny"  }
--     ]
--   }'
-- );
-- 
-- Corbin — member; lighter access until confirmed; SF status unknown
-- INSERT INTO henry_people (profile_id, email, display_name, role, sf_username_gtmops, sf_username_prod, access)
-- VALUES (
--   '⚠️ QUESTION(joe): Corbin''s OpenClaw profile_id (after his first Access login)',
--   'clarson@isidefense.com',                 -- verified: Access policy, 2026-09-05
--   'Corbin Larson',
--   'member',
--   NULL,
--   NULL,
--   '{
--     "defaultVerdict": "deny",
--     "rules": [
--       { "glob": "read",              "verdict": "allow" },
--       { "glob": "web_fetch",         "verdict": "allow" },
--       { "glob": "web_search",        "verdict": "allow" },
--       { "glob": "memory_search",     "verdict": "allow" },
--       { "glob": "session_status",    "verdict": "allow" },
--       { "glob": "mcp:monday:*",      "verdict": "allow" },
--       { "glob": "exec",              "verdict": "deny"  }
--     ]
--   }'
-- );
