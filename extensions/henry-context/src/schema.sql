-- henry-context schema: henry_team_context + henry_memory tables.
--
-- These two tables ALREADY EXIST on the live Henry VM (applied via
-- scripts/sprint1/henry-schema-draft.sql as the postgres superuser against db
-- "henry"). This file is the canonical in-repo copy; it must remain identical
-- to that applied script for those two tables. Use CREATE TABLE IF NOT EXISTS
-- so it is safe to apply against an already-migrated database.
--
-- henry_people and henry_policy_decisions are owned by henry-policy (Plan 4).
-- This migration adds only the henry-context-owned tables.

-- Stable team context. Exactly one row, maintained by an admin.
-- The CHECK (id = 1) constraint enforces the single-row invariant.
CREATE TABLE IF NOT EXISTS henry_team_context (
    id          SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    content_md  TEXT        NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-person episodic memory items written by the session-end flush.
-- profile_id is a foreign key back to henry_people; rows are cascade-deleted
-- when a person is removed.
CREATE TABLE IF NOT EXISTS henry_memory (
    id             BIGSERIAL   PRIMARY KEY,
    profile_id     TEXT        NOT NULL REFERENCES henry_people(profile_id) ON DELETE CASCADE,
    at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind           TEXT        NOT NULL DEFAULT 'session',
    content        TEXT        NOT NULL,
    source_session TEXT
);

CREATE INDEX IF NOT EXISTS henry_memory_profile_at
    ON henry_memory (profile_id, at DESC);
