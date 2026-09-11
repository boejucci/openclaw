import type { Pool } from "pg";

export type PersonRow = {
  profileId: string;
  email: string;
  displayName: string | null;
  role: "admin" | "member" | "guest";
  access: unknown;
};

export type HenryDb = {
  /** Returns the henry_people row for profileId, or null if not found. */
  getPerson(profileId: string): Promise<PersonRow | null>;
  /** Closes all pool connections. Call at gateway_stop. */
  close(): Promise<void>;
};

type CacheEntry = { row: PersonRow | null; expiresAtMs: number };

export function createHenryDb(params: {
  pool: Pool;
  cacheTtlMs: number;
  now?: () => number;
}): HenryDb {
  const { pool, cacheTtlMs } = params;
  const now = params.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<PersonRow | null>>();

  async function fetchFromDb(profileId: string): Promise<PersonRow | null> {
    const result = await pool.query(
      "SELECT profile_id, email, display_name, role, access FROM henry_people WHERE profile_id = $1",
      [profileId],
    );
    if (result.rows.length === 0) {
      return null;
    }
    const r = result.rows[0] as {
      profile_id: string;
      email: string;
      display_name: string | null;
      role: "admin" | "member" | "guest";
      access: unknown;
    };
    return {
      profileId: r.profile_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      access: r.access,
    };
  }

  return {
    async getPerson(profileId: string): Promise<PersonRow | null> {
      const cached = cache.get(profileId);
      if (cached !== undefined && now() < cached.expiresAtMs) {
        return cached.row;
      }

      const existing = inFlight.get(profileId);
      if (existing !== undefined) {
        return existing;
      }

      // Stored synchronously so concurrent callers share this promise even when
      // caching is disabled; the settle handlers below remove it from in-flight.
      const promise = fetchFromDb(profileId);
      inFlight.set(profileId, promise);

      promise.then(
        (row) => {
          inFlight.delete(profileId);
          if (cacheTtlMs > 0) {
            cache.set(profileId, { row, expiresAtMs: now() + cacheTtlMs });
          }
        },
        () => {
          inFlight.delete(profileId);
        },
      );

      return promise;
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
