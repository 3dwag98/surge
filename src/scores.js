/**
 * Leaderboard rules shared by the browser client and the Node server, so both
 * sides validate and rank entries identically.
 */

export const LEADERBOARD_LIMIT = 10;
export const MAX_NAME_LENGTH = 16;
export const MAX_SCORE = 10_000_000;
export const MAX_TILE = 1_048_576;
export const DEFAULT_NAME = 'Anonymous';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Reduce arbitrary user input to a short, single-line display name.
 * Control characters are dropped rather than escaped; the UI renders names as
 * text nodes, so this is about tidiness, not about making markup safe.
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned || DEFAULT_NAME;
}

function requireCount(value, field, max) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new ValidationError(`${field} must be an integer between 0 and ${max}`);
  }
  return number;
}

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value >= 2 && (value & (value - 1)) === 0;
}

/**
 * Validate a submitted run and fill in its server-side fields.
 *
 * @param {object} raw Untrusted entry from a client.
 * @param {object} [options]
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {() => string} [options.id] Identifier factory.
 * @returns {{id: string, name: string, score: number, bestTile: number,
 *            moves: number, durationMs: number, createdAt: string}}
 * @throws {ValidationError}
 */
export function normalizeEntry(raw, { now = Date.now, id = randomId } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('entry must be an object');
  }

  const score = requireCount(raw.score, 'score', MAX_SCORE);
  const moves = raw.moves === undefined ? 0 : requireCount(raw.moves, 'moves', MAX_SCORE);
  const durationMs =
    raw.durationMs === undefined ? 0 : requireCount(raw.durationMs, 'durationMs', Number.MAX_SAFE_INTEGER);

  let bestTile = 0;
  if (raw.bestTile !== undefined && raw.bestTile !== null && raw.bestTile !== 0) {
    const candidate = typeof raw.bestTile === 'string' ? Number(raw.bestTile) : raw.bestTile;
    if (!isPowerOfTwo(candidate) || candidate > MAX_TILE) {
      throw new ValidationError('bestTile must be a power of two');
    }
    bestTile = candidate;
  }

  return {
    id: id(),
    name: sanitizeName(raw.name),
    score,
    bestTile,
    moves,
    durationMs,
    createdAt: new Date(now()).toISOString(),
  };
}

/**
 * Order entries best-first. Ties break toward the bigger tile, then toward
 * whoever posted the score first.
 */
export function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if ((b.bestTile ?? 0) !== (a.bestTile ?? 0)) return (b.bestTile ?? 0) - (a.bestTile ?? 0);
  const aTime = Date.parse(a.createdAt ?? '') || 0;
  const bTime = Date.parse(b.createdAt ?? '') || 0;
  return aTime - bTime;
}

/** Sorted top `limit` entries. Does not mutate the input. */
export function rankEntries(entries, limit = LEADERBOARD_LIMIT) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && Number.isFinite(entry.score))
    .slice()
    .sort(compareEntries)
    .slice(0, limit);
}

/**
 * Add `entry` to `entries` and return the trimmed board plus the entry's
 * 1-based rank, or `null` when it did not make the cut.
 */
export function insertEntry(entries, entry, limit = LEADERBOARD_LIMIT) {
  const ranked = rankEntries([...(entries ?? []), entry], limit);
  const index = ranked.findIndex((candidate) => candidate.id === entry.id);
  return { entries: ranked, rank: index === -1 ? null : index + 1 };
}

/** Whether `score` would earn a place on the board. */
export function qualifies(entries, score, limit = LEADERBOARD_LIMIT) {
  if (!Number.isFinite(score) || score <= 0) return false;
  const ranked = rankEntries(entries, limit);
  return ranked.length < limit || score > ranked[ranked.length - 1].score;
}

/** URL-safe random identifier, unique enough for a leaderboard row. */
export function randomId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}
