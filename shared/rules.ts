/**
 * Rules shared by the browser and the Worker, so both sides agree on what a
 * valid name, run or banner claim looks like.
 */

export const LEADERBOARD_LIMIT = 25;
export const MAX_NAME_LENGTH = 18;
export const DEFAULT_NAME = 'anon';

/** Banner copy limits. */
export const MAX_BANNER_TEXT = 80;
export const MAX_BANNER_URL = 300;

/** Outbid rules: a claim must beat the standing bid by at least this much. */
export const MIN_BID_USD = 1;
export const MIN_OUTBID_INCREMENT_USD = 1;
export const MAX_BID_USD = 100_000;

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
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned || DEFAULT_NAME;
}

/** Same treatment for banner copy, with a longer allowance. */
export function sanitizeBannerText(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('banner text is required');
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BANNER_TEXT)
    .trim();
  if (!cleaned) throw new ValidationError('banner text is required');
  return cleaned;
}

/**
 * Accept only a plain https URL. Anything else — javascript:, data:, a bare
 * host, credentials in the authority — is rejected outright, because this
 * value ends up in an href other people will click.
 */
export function sanitizeBannerUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError('a link is required');
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_BANNER_URL) throw new ValidationError('link is too long');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError('link must be a full https:// URL');
  }
  if (url.protocol !== 'https:') throw new ValidationError('link must use https');
  if (url.username || url.password) throw new ValidationError('link may not carry credentials');
  if (!url.hostname.includes('.')) throw new ValidationError('link needs a real hostname');
  return url.toString();
}

/** Money, in whole cents, so nothing rides on float arithmetic. */
export function parseUsdToCents(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('amount must be a number');
  }
  // `1.005 * 100` is 100.49999... in binary floating point, which would round
  // a bid down by a cent. Nudging by one ulp puts these half-cent cases on the
  // side the decimal notation implies.
  const cents = Math.round((value + Number.EPSILON) * 100);
  if (cents < MIN_BID_USD * 100) throw new ValidationError(`minimum bid is $${MIN_BID_USD}`);
  if (cents > MAX_BID_USD * 100) throw new ValidationError('amount is too large');
  return cents;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The smallest bid that would take the banner from the current holder. */
export function minimumClaimCents(currentCents: number | null | undefined): number {
  const standing = typeof currentCents === 'number' && currentCents > 0 ? currentCents : 0;
  if (standing === 0) return MIN_BID_USD * 100;
  return standing + MIN_OUTBID_INCREMENT_USD * 100;
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
