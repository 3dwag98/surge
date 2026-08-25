/**
 * Rules shared by the browser and the Worker, so both sides agree on what a
 * valid name, run or board listing looks like.
 *
 * The board is an auction, not a single slot. Any bid at or above the entry
 * price puts you on the board at whatever rank that money buys; paying less
 * than the leader does not fail, it just seats you lower. Only #1 has a moving
 * price, because taking the top from someone means beating what they paid.
 */

export const LEADERBOARD_LIMIT = 25;

/** How many paid listings the board shows. */
export const BOARD_LIMIT = 50;

/** Side banner slots flanking the game, won by score rather than bought. */
export const SIDE_SLOTS = 3;

export const MAX_NAME_LENGTH = 18;
export const DEFAULT_NAME = 'anon';

/** Listing copy limits. */
export const MAX_LISTING_TITLE = 60;
export const MAX_LISTING_TAGLINE = 140;
export const MAX_LISTING_URL = 300;

/**
 * Bidding opens at $0 and climbs from there — there is no entry fee and no
 * floor to clear, only whatever the people above you have already paid.
 */
export const MIN_BID_USD = 0;
/** To take #1 you must beat the standing top bid by at least this. */
export const MIN_OUTBID_INCREMENT_USD = 1;
export const MAX_BID_USD = 100_000;

/**
 * The smallest amount that can actually be charged.
 *
 * Bidding *starts* at $0, but nobody can be billed nothing — PayPal will not
 * capture a zero order. So $0 is the number the board advertises and one cent
 * is the first bid that can really be placed.
 */
export const MIN_PAYABLE_CENTS = 1;

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

/** Collapse to a single tidy line, capped at `limit`. */
function singleLine(raw: string, limit: number): string {
  return raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
    .trim();
}

/** The bold line of a listing. Required. */
export function sanitizeListingTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('a title is required');
  const cleaned = singleLine(raw, MAX_LISTING_TITLE);
  if (!cleaned) throw new ValidationError('a title is required');
  return cleaned;
}

/** The grey line under it. Optional — an empty tagline is a valid listing. */
export function sanitizeListingTagline(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return singleLine(raw, MAX_LISTING_TAGLINE);
}

/**
 * Accept only a plain https URL. Anything else — javascript:, data:, a bare
 * host, credentials in the authority — is rejected outright, because this
 * value ends up in an href other people will click.
 */
export function sanitizeListingUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError('a link is required');
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_LISTING_URL) throw new ValidationError('link is too long');

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

/** Same rules, but an absent link is allowed. Used for earned side slots. */
export function sanitizeOptionalUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  return sanitizeListingUrl(raw);
}

/**
 * Money, in whole cents, so nothing rides on float arithmetic.
 *
 * This only parses and bounds the number. Whether it is *enough* is a board
 * question, not a parsing one — see `assertBidCents`.
 */
export function parseUsdToCents(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('amount must be a number');
  }
  // `1.005 * 100` is 100.49999... in binary floating point, which would round
  // a bid down by a cent. Nudging by one ulp puts these half-cent cases on the
  // side the decimal notation implies.
  const cents = Math.round((value + Number.EPSILON) * 100);
  if (cents < 1) throw new ValidationError('amount must be positive');
  if (cents > MAX_BID_USD * 100) throw new ValidationError('amount is too large');
  return cents;
}

export function formatCents(cents: number): string {
  const dollars = cents / 100;
  // Whole dollars read better without the trailing zeros on a busy board.
  return dollars % 1 === 0 ? `$${dollars.toLocaleString()}` : `$${dollars.toFixed(2)}`;
}

/** Where bidding opens. Zero: any amount at all earns a place on the board. */
export function entryCents(): number {
  return MIN_BID_USD * 100;
}

/**
 * What it costs to take #1.
 *
 * On an empty board that is $0 — the top spot is free until somebody pays for
 * it. After that it is the standing bid plus the increment.
 */
export function topSpotCents(currentTopCents: number | null | undefined): number {
  const standing = typeof currentTopCents === 'number' && currentTopCents > 0 ? currentTopCents : 0;
  if (standing === 0) return entryCents();
  return standing + MIN_OUTBID_INCREMENT_USD * 100;
}

/**
 * Reject a bid that cannot be charged.
 *
 * There is no floor to clear any more, so the only thing that fails here is an
 * amount PayPal could not capture in the first place.
 */
export function assertBidCents(cents: number): void {
  if (cents < MIN_PAYABLE_CENTS) {
    throw new ValidationError('bids start above $0');
  }
}

export interface Listing {
  id: string;
  title: string;
  tagline: string;
  url: string;
  name: string;
  amountCents: number;
  claimedAt: string;
}

/** Most money first; a tie goes to whoever paid it first. */
export function compareListings(a: Listing, b: Listing): number {
  if (b.amountCents !== a.amountCents) return b.amountCents - a.amountCents;
  return (Date.parse(a.claimedAt) || 0) - (Date.parse(b.claimedAt) || 0);
}

export function rankListings(rows: readonly Listing[], limit = BOARD_LIMIT): Listing[] {
  return rows
    .filter((row) => row && Number.isFinite(row.amountCents) && row.amountCents > 0)
    .slice()
    .sort(compareListings)
    .slice(0, limit);
}

/**
 * Where a bid of `cents` would land on the board.
 *
 * A tie seats below the incumbent — whoever paid it first keeps the better
 * rank — so an equal bid counts as already-taken. This is what the claim form
 * quotes back at the bidder, so it has to agree with `compareListings`.
 */
export function rankFor(listings: readonly Listing[], cents: number): number {
  let ahead = 0;
  for (const row of listings) if (row.amountCents >= cents) ahead += 1;
  return ahead + 1;
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
  /** Set when the player attached a link to the side slot they earned. */
  url?: string | null;
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
 * The side slots, earned rather than bought.
 *
 * One per player: a single hot streak should not take every slot, so only a
 * player's best run counts and the remaining slots go to other people.
 */
export function sideSlots(rows: readonly ScoreRow[], count = SIDE_SLOTS): ScoreRow[] {
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
