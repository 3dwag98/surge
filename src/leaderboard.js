/**
 * Leaderboard client.
 *
 * Prefers the shared server board at /api/scores so every player on the same
 * host sees the same table. When there is no server — the page opened from a
 * static host or straight off disk — it transparently keeps a private board in
 * localStorage instead. The active mode is reported as `source` so the UI can
 * say which one is in play.
 */

import {
  LEADERBOARD_LIMIT,
  insertEntry,
  normalizeEntry,
  qualifies,
  rankEntries,
} from './scores.js';

export const STORAGE_KEY = '2048.leaderboard';

const REQUEST_TIMEOUT_MS = 4000;

/** Statuses that mean "there is no leaderboard API here", not "your run is bad". */
const NO_ENDPOINT = new Set([404, 405, 410, 501]);

/**
 * Distinguish "the server is not there" — fall back to local storage — from
 * "the server looked at this run and refused it", which the player must see.
 */
function isOutage(error) {
  if (!error?.status) return true; // network failure, timeout, or unparseable reply
  if (error.status >= 500) return true;
  return NO_ENDPOINT.has(error.status);
}

export function createLeaderboard({
  fetch: fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  storage,
  endpoint = '/api/scores',
  limit = LEADERBOARD_LIMIT,
} = {}) {
  if (!storage) throw new TypeError('a storage backend is required');

  // null = not probed yet, 'server' | 'local' once decided.
  let source = fetchImpl ? null : 'local';

  function readLocal() {
    return rankEntries(storage.getJSON(STORAGE_KEY, []), limit);
  }

  function writeLocal(entries) {
    storage.setJSON(STORAGE_KEY, entries);
    return entries;
  }

  async function request(path, init) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await fetchImpl(path, { ...init, signal: controller?.signal });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`server responded ${response.status}: ${detail.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    /** Which board is in use: 'server' or 'local'. Null until the first call. */
    get source() {
      return source;
    },

    /** @returns {Promise<{entries: object[], source: string}>} */
    async list() {
      if (source !== 'local' && fetchImpl) {
        try {
          const data = await request(`${endpoint}?limit=${limit}`);
          source = 'server';
          return { entries: rankEntries(data?.scores ?? [], limit), source };
        } catch (error) {
          if (!isOutage(error)) throw error;
          source = 'local';
        }
      }
      source = 'local';
      return { entries: readLocal(), source };
    },

    /**
     * Post a finished run.
     * @returns {Promise<{entries: object[], source: string, rank: number|null,
     *                    entryId: string|null}>}
     */
    async submit(entry) {
      if (source !== 'local' && fetchImpl) {
        try {
          const data = await request(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(entry),
          });
          source = 'server';
          return {
            entries: rankEntries(data?.scores ?? [], limit),
            rank: data?.rank ?? null,
            entryId: data?.entry?.id ?? null,
            source,
          };
        } catch (error) {
          // A rejected run is the server's answer, not an outage: show it.
          if (!isOutage(error)) throw error;
          source = 'local';
        }
      }

      source = 'local';
      const normalized = normalizeEntry(entry);
      const { entries, rank } = insertEntry(readLocal(), normalized, limit);
      writeLocal(entries);
      return { entries, rank, entryId: normalized.id, source };
    },

    /** Whether `score` would place on the currently displayed board. */
    qualifies(entries, score) {
      return qualifies(entries, score, limit);
    },

    /** Wipe the local board. The server board is left untouched. */
    clearLocal() {
      storage.removeItem(STORAGE_KEY);
    },
  };
}
