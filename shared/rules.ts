/**
 * Rules shared by the browser and the Worker, so both sides agree on what a
 * valid name or score looks like and on how runs are ordered.
 *
 * There is exactly one board now: the high scores, which are free to enter and
 * verified server-side. Nothing here can be bought.
 */

export const LEADERBOARD_LIMIT = 25;

/** How many runs the podium beside the game shows. */
export const PODIUM_SIZE = 3;

export const MAX_NAME_LENGTH = 18;
export const DEFAULT_NAME = 'anon';

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Reduce arbitrary input to a short single-line handle.
 * Control characters are dropped rather than escaped — the UI renders names as
 * text nodes, so this is about tidiness, not markup safety.
 */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  const cleaned = raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned || DEFAULT_NAME;
}

export interface ScoreRow {
  id: string;
  name: string;
  score: number;
  level: number;
  bestTile: number;
  merges: number;
  durationMs: number;
  createdAt: string;
}

/** Best first; ties break toward the higher tile, then to whoever got there first. */
export function compareScores(a: ScoreRow, b: ScoreRow): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.bestTile !== a.bestTile) return b.bestTile - a.bestTile;
  return (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
}

export function rankScores(rows: readonly ScoreRow[], limit = LEADERBOARD_LIMIT): ScoreRow[] {
  return rows
    .filter((row) => row && Number.isFinite(row.score))
    .slice()
    .sort(compareScores)
    .slice(0, limit);
}

/**
 * The podium beside the game.
 *
 * One place per player: a single hot streak should not take all three, so only
 * a player's best run counts and the remaining places go to other people.
 */
export function podium(rows: readonly ScoreRow[], count = PODIUM_SIZE): ScoreRow[] {
  const seen = new Set<string>();
  const out: ScoreRow[] = [];
  for (const row of rankScores(rows, rows.length)) {
    const key = (row.name || DEFAULT_NAME).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= count) break;
  }
  return out;
}
