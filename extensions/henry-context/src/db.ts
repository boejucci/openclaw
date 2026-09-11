import type { Pool } from "pg";

// ── Public types ─────────────────────────────────────────────────────────────

export type HenryTeamContext = { contentMd: string; updatedAt: Date };

export type HenryPeopleFact = {
  profileId: string;
  displayName: string;
  /** Aligned with the henry_people CHECK constraint: 'admin' | 'member' | 'guest'. */
  role: "admin" | "member" | "guest";
  contextMd: string;
};

export type HenryMemoryItem = {
  id: bigint;
  at: Date;
  kind: string;
  content: string;
  sourceSession?: string;
};

export type HenryMemoryRow = {
  profileId: string;
  at: Date;
  kind: string;
  content: string;
  sourceSession?: string;
};

export type HenryContextDb = {
  /** Returns null if the henry_team_context row does not exist. */
  getTeamContext(): Promise<HenryTeamContext | null>;
  /** Returns null if no henry_people row exists for this profile. */
  getPerson(profileId: string): Promise<HenryPeopleFact | null>;
  /**
   * Returns the most recent items for this profile, newest first.
   * Results are served from the speaker cache (populated at the configured
   * memoryItemLimit). The `limit` parameter slices the cached array — it
   * cannot exceed memoryItemLimit. On Postgres error, stale cache is returned
   * if within staleTtlMs; otherwise [].
   */
  getMemory(profileId: string, limit?: number): Promise<HenryMemoryItem[]>;
  /**
   * Inserts a new henry_memory row. Resolves when written.
   * May throw — callers are responsible for handling write failures.
   */
  writeMemory(row: HenryMemoryRow): Promise<void>;
};

export type CachedContextDb = HenryContextDb & {
  invalidateTeam(): void;
  invalidateSpeaker(profileId: string): void;
};

// ── Internal cache shapes ────────────────────────────────────────────────────

type TeamCacheEntry = { value: HenryTeamContext | null; fetchedAt: number };
type SpeakerCacheEntry = {
  person: HenryPeopleFact | null;
  memory: HenryMemoryItem[];
  fetchedAt: number;
};

// ── Factory ──────────────────────────────────────────────────────────────────

export function createHenryContextDb(params: {
  pool: Pool;
  teamTtlMs?: number;
  speakerTtlMs?: number;
  staleTtlMs?: number;
  queryTimeoutMs?: number;
  memoryItemLimit?: number;
  now?: () => number;
  warn?: (msg: string) => void;
}): CachedContextDb {
  const {
    pool,
    teamTtlMs = 600_000,
    speakerTtlMs = 300_000,
    staleTtlMs = 1_800_000,
    queryTimeoutMs = 10_000,
    memoryItemLimit = 10,
    now = Date.now,
    warn = (msg: string) => console.warn(msg),
  } = params;

  let teamCache: TeamCacheEntry | null = null;
  let teamInFlight: Promise<HenryTeamContext | null> | null = null;

  const speakerCache = new Map<string, SpeakerCacheEntry>();
  const speakerInFlight = new Map<string, Promise<SpeakerCacheEntry>>();

  // Rate-limited warn: at most one warn per 60 s across all read-path errors.
  let lastWarnAt = -Infinity;
  function rateLimitedWarn(msg: string): void {
    const t = now();
    if (t - lastWarnAt >= 60_000) {
      lastWarnAt = t;
      warn(msg);
    }
  }

  // ── Query helpers ──────────────────────────────────────────────────────────

  async function queryTeamFromDb(): Promise<HenryTeamContext | null> {
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error("henry-context: getTeamContext query timed out"));
      }, queryTimeoutMs);
      // Allow Node to exit if this is the only pending timer.
      if (typeof t.unref === "function") {
        t.unref();
      }
    });

    const query = pool.query("SELECT content_md, updated_at FROM henry_team_context WHERE id = 1");

    const result = await Promise.race([query, timeout]);

    if (result.rows.length === 0) {
      return null;
    }
    const r = result.rows[0] as { content_md: string; updated_at: Date };
    return { contentMd: r.content_md, updatedAt: r.updated_at };
  }

  async function queryPersonFromDb(profileId: string): Promise<HenryPeopleFact | null> {
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error("henry-context: getPerson query timed out"));
      }, queryTimeoutMs);
      if (typeof t.unref === "function") {
        t.unref();
      }
    });

    const query = pool.query(
      "SELECT profile_id, display_name, role, context_md FROM henry_people WHERE profile_id = $1",
      [profileId],
    );

    const result = await Promise.race([query, timeout]);

    if (result.rows.length === 0) {
      return null;
    }
    const r = result.rows[0] as {
      profile_id: string;
      display_name: string | null;
      role: "admin" | "member" | "guest";
      context_md: string | null;
    };
    return {
      profileId: r.profile_id,
      displayName: r.display_name ?? "",
      role: r.role,
      contextMd: r.context_md ?? "",
    };
  }

  async function queryPersonAndMemoryFromDb(
    profileId: string,
  ): Promise<{ person: HenryPeopleFact | null; memory: HenryMemoryItem[] }> {
    const [person, memory] = await Promise.all([
      queryPersonFromDb(profileId),
      queryMemoryFromDb(profileId, memoryItemLimit),
    ]);
    return { person, memory };
  }

  async function queryMemoryFromDb(profileId: string, limit: number): Promise<HenryMemoryItem[]> {
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error("henry-context: getMemory query timed out"));
      }, queryTimeoutMs);
      if (typeof t.unref === "function") {
        t.unref();
      }
    });

    const query = pool.query(
      "SELECT id, at, kind, content, source_session FROM henry_memory WHERE profile_id = $1 ORDER BY at DESC LIMIT $2",
      [profileId, limit],
    );

    const result = await Promise.race([query, timeout]);

    return (
      result.rows as Array<{
        id: bigint | string;
        at: Date;
        kind: string;
        content: string;
        source_session: string | null;
      }>
    ).map((r) => {
      const item: HenryMemoryItem = {
        id: BigInt(r.id as string | bigint),
        at: r.at,
        kind: r.kind,
        content: r.content,
      };
      if (r.source_session !== null) {
        item.sourceSession = r.source_session;
      }
      return item;
    });
  }

  // ── Public interface ───────────────────────────────────────────────────────

  return {
    async getTeamContext(): Promise<HenryTeamContext | null> {
      const t = now();

      // Cache hit: return immediately.
      if (teamCache !== null && t - teamCache.fetchedAt < teamTtlMs) {
        return teamCache.value;
      }

      // Single-flight: reuse in-flight promise if one is already pending.
      if (teamInFlight !== null) {
        return teamInFlight;
      }

      const promise = queryTeamFromDb();
      teamInFlight = promise;

      let result: HenryTeamContext | null;
      try {
        result = await promise;
      } catch (err) {
        teamInFlight = null;
        // Stale-on-error: return stale entry if within staleTtlMs.
        if (teamCache !== null && t - teamCache.fetchedAt < staleTtlMs) {
          return teamCache.value;
        }
        void err;
        return null;
      }

      // Update cache before clearing in-flight to close the narrow race window
      // where a concurrent caller could find in-flight=null and cache not yet set.
      teamCache = { value: result, fetchedAt: t };
      teamInFlight = null;
      return result;
    },

    async getPerson(profileId: string): Promise<HenryPeopleFact | null> {
      const t = now();
      const cached = speakerCache.get(profileId);

      // Cache hit.
      if (cached !== undefined && t - cached.fetchedAt < speakerTtlMs) {
        return cached.person;
      }

      // Single-flight.
      const existing = speakerInFlight.get(profileId);
      if (existing !== undefined) {
        return (await existing).person;
      }

      const promise = queryPersonAndMemoryFromDb(profileId).then(({ person, memory }) => {
        const entry: SpeakerCacheEntry = { person, memory, fetchedAt: now() };
        speakerCache.set(profileId, entry);
        speakerInFlight.delete(profileId);
        return entry;
      });

      // Register before first await so concurrent callers find it.
      speakerInFlight.set(profileId, promise);

      let entry: SpeakerCacheEntry;
      try {
        entry = await promise;
      } catch (err) {
        speakerInFlight.delete(profileId);
        rateLimitedWarn("henry-context: getPerson/getMemory read error (no row content)");
        // Stale-on-error.
        if (cached !== undefined && t - cached.fetchedAt < staleTtlMs) {
          return cached.person;
        }
        void err;
        return null;
      }

      return entry.person;
    },

    async getMemory(profileId: string, limit?: number): Promise<HenryMemoryItem[]> {
      // Memory is co-fetched with person data and stored in the speaker cache
      // (SpeakerCacheEntry.memory) at the configured memoryItemLimit. This avoids
      // an extra Postgres round-trip per turn. The optional limit parameter slices
      // the cached array; it cannot request more than memoryItemLimit items.
      const t = now();
      const cached = speakerCache.get(profileId);
      const effectiveLimit = limit !== undefined ? limit : memoryItemLimit;

      // Cache hit (same TTL as person cache).
      if (cached !== undefined && t - cached.fetchedAt < speakerTtlMs) {
        return cached.memory.slice(0, effectiveLimit);
      }

      // On cache miss, query directly (single-flight is handled by getPerson;
      // this path handles callers that call getMemory without getPerson first).
      try {
        const memory = await queryMemoryFromDb(profileId, effectiveLimit);
        // Update the cache entry if it exists (stale but present); otherwise create one.
        const prev = speakerCache.get(profileId);
        if (prev !== undefined) {
          speakerCache.set(profileId, { ...prev, memory, fetchedAt: t });
        }
        return memory;
      } catch (err) {
        rateLimitedWarn("henry-context: getMemory read error (no row content)");
        // Stale-on-error: return stale cached memory if within staleTtlMs.
        if (cached !== undefined && t - cached.fetchedAt < staleTtlMs) {
          return cached.memory.slice(0, effectiveLimit);
        }
        void err;
        return [];
      }
    },

    async writeMemory(row: HenryMemoryRow): Promise<void> {
      const timeout = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(new Error("henry-context: writeMemory query timed out"));
        }, queryTimeoutMs);
        if (typeof t.unref === "function") {
          t.unref();
        }
      });

      await Promise.race([
        pool.query(
          "INSERT INTO henry_memory (profile_id, at, kind, content, source_session) VALUES ($1, $2, $3, $4, $5)",
          [row.profileId, row.at, row.kind, row.content, row.sourceSession ?? null],
        ),
        timeout,
      ]);
    },

    invalidateTeam(): void {
      teamCache = null;
      teamInFlight = null;
    },

    invalidateSpeaker(profileId: string): void {
      speakerCache.delete(profileId);
      speakerInFlight.delete(profileId);
    },
  };
}
