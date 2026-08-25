import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NAME,
  LEADERBOARD_LIMIT,
  MAX_LISTING_TAGLINE,
  MAX_LISTING_TITLE,
  MAX_NAME_LENGTH,
  MIN_BID_USD,
  MIN_PAYABLE_CENTS,
  SIDE_SLOTS,
  ValidationError,
  assertBidCents,
  compareScores,
  entryCents,
  formatCents,
  parseUsdToCents,
  rankFor,
  rankListings,
  rankScores,
  sanitizeListingTagline,
  sanitizeListingTitle,
  sanitizeListingUrl,
  sanitizeName,
  sanitizeOptionalUrl,
  sideSlots,
  topSpotCents,
  type Listing,
  type ScoreRow,
} from '../shared/rules.js';

const CTRL = String.fromCharCode(0, 27); // NUL, ESC

const row = (over: Partial<ScoreRow> = {}): ScoreRow => ({
  id: Math.random().toString(36).slice(2),
  name: 'player',
  score: 100,
  level: 3,
  bestTile: 64,
  merges: 20,
  durationMs: 30_000,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: Math.random().toString(36).slice(2),
  title: 'a thing',
  tagline: '',
  url: 'https://example.com/',
  name: 'seller',
  amountCents: 1000,
  claimedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('names', () => {
  it('trims, collapses and caps', () => {
    expect(sanitizeName('  Ada  ')).toBe('Ada');
    expect(sanitizeName('Ada   Lovelace')).toBe('Ada Lovelace');
    expect(sanitizeName('x'.repeat(80))).toHaveLength(MAX_NAME_LENGTH);
  });

  it('falls back for unusable input', () => {
    for (const input of ['', '   ', undefined, null, 42, {}]) {
      expect(sanitizeName(input)).toBe(DEFAULT_NAME);
    }
  });

  it('strips control characters', () => {
    expect(sanitizeName(`Ada${CTRL}Love`)).toBe('Ada Love');
    expect(sanitizeName('two\nlines')).toBe('two lines');
  });

  it('leaves markup as literal text', () => {
    // Names render through textContent, so brackets are just characters.
    expect(sanitizeName('<img src=x>')).toBe('<img src=x>');
  });
});

describe('listing copy', () => {
  it('cleans and caps the title', () => {
    expect(sanitizeListingTitle('  buy   my   thing ')).toBe('buy my thing');
    expect(sanitizeListingTitle('y'.repeat(300))).toHaveLength(MAX_LISTING_TITLE);
  });

  it('requires a title', () => {
    for (const input of ['', '    ', '\n\n', undefined, 12]) {
      expect(() => sanitizeListingTitle(input)).toThrow(ValidationError);
    }
  });

  it('treats the tagline as optional', () => {
    expect(sanitizeListingTagline('  does   things ')).toBe('does things');
    expect(sanitizeListingTagline('z'.repeat(400))).toHaveLength(MAX_LISTING_TAGLINE);
    for (const input of ['', '   ', undefined, null, 42]) {
      expect(sanitizeListingTagline(input)).toBe('');
    }
  });

  it('strips control characters from both', () => {
    expect(sanitizeListingTitle(`a${CTRL}b`)).toBe('a b');
    expect(sanitizeListingTagline(`a${CTRL}b`)).toBe('a b');
  });
});

describe('listing links', () => {
  it('accepts a plain https url', () => {
    expect(sanitizeListingUrl('https://example.com/path?a=1')).toBe('https://example.com/path?a=1');
    expect(sanitizeListingUrl('  https://example.com  ')).toBe('https://example.com/');
  });

  it('rejects anything that is not https', () => {
    // This value becomes an href other people click, so the bar is high.
    const bad = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://example.com',
      'ftp://example.com',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'example.com',
      '//example.com',
      '',
      '   ',
      undefined,
      null,
      42,
    ];
    for (const input of bad) {
      expect(() => sanitizeListingUrl(input), `should reject ${String(input)}`).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects credentials in the authority', () => {
    expect(() => sanitizeListingUrl('https://user:pass@example.com')).toThrow(ValidationError);
  });

  it('requires a real hostname', () => {
    expect(() => sanitizeListingUrl('https://localhost')).toThrow(ValidationError);
  });

  it('rejects an over-long link', () => {
    expect(() => sanitizeListingUrl(`https://example.com/${'a'.repeat(400)}`)).toThrow(
      ValidationError,
    );
  });

  it('allows an absent optional link but still vets a present one', () => {
    for (const input of ['', '   ', undefined, null]) {
      expect(sanitizeOptionalUrl(input)).toBeNull();
    }
    expect(sanitizeOptionalUrl('https://example.com')).toBe('https://example.com/');
    // An empty link is fine; a hostile one is not.
    expect(() => sanitizeOptionalUrl('javascript:alert(1)')).toThrow(ValidationError);
  });
});

describe('money', () => {
  it('converts dollars to whole cents', () => {
    expect(parseUsdToCents(5)).toBe(500);
    expect(parseUsdToCents('12.34')).toBe(1234);
    expect(parseUsdToCents(1.005)).toBe(101); // rounds, never floats
  });

  it('rejects junk and out-of-range amounts', () => {
    expect(() => parseUsdToCents(0)).toThrow(ValidationError);
    expect(() => parseUsdToCents(-5)).toThrow(ValidationError);
    expect(() => parseUsdToCents(1e9)).toThrow(ValidationError);
    expect(() => parseUsdToCents('abc')).toThrow(ValidationError);
    expect(() => parseUsdToCents(NaN)).toThrow(ValidationError);
    expect(() => parseUsdToCents(Infinity)).toThrow(ValidationError);
  });

  it('formats for display, dropping empty cents', () => {
    expect(formatCents(1234)).toBe('$12.34');
    expect(formatCents(100)).toBe('$1');
    expect(formatCents(1_700_000)).toBe('$17,000');
  });
});

describe('board pricing', () => {
  it('opens bidding at $0', () => {
    expect(MIN_BID_USD).toBe(0);
    expect(entryCents()).toBe(0);
  });

  it('accepts any amount that can actually be charged', () => {
    // There is no floor to clear, so the only rejection is an uncapturable
    // amount — PayPal will not take an order for nothing.
    expect(() => assertBidCents(MIN_PAYABLE_CENTS)).not.toThrow();
    expect(() => assertBidCents(1)).not.toThrow();
    expect(() => assertBidCents(50)).not.toThrow();
    expect(() => assertBidCents(9_999_999)).not.toThrow();
    expect(() => assertBidCents(0)).toThrow(ValidationError);
    expect(() => assertBidCents(-1)).toThrow(ValidationError);
  });

  it('gives #1 away free until somebody pays for it', () => {
    expect(topSpotCents(null)).toBe(0);
    expect(topSpotCents(0)).toBe(0);
    expect(topSpotCents(undefined)).toBe(0);
  });

  it('requires beating the leader to take #1', () => {
    expect(topSpotCents(500)).toBe(600);
    // Matching the leader is not enough to take the top spot.
    expect(topSpotCents(500)).toBeGreaterThan(500);
  });

  it('seats a one-cent bid rather than rejecting it', () => {
    // The whole point of the model: a small bid is a low rank, not an error.
    expect(() => assertBidCents(MIN_PAYABLE_CENTS)).not.toThrow();
    expect(MIN_PAYABLE_CENTS).toBeLessThan(topSpotCents(10_000));
  });
});

describe('where a bid lands', () => {
  const board = [
    listing({ id: 'a', amountCents: 5000 }),
    listing({ id: 'b', amountCents: 2000 }),
    listing({ id: 'c', amountCents: 1000 }),
  ];

  it('puts a bigger bid on top', () => {
    expect(rankFor(board, 6000)).toBe(1);
  });

  it('slots a middling bid between the neighbours it beats', () => {
    expect(rankFor(board, 3000)).toBe(2);
    expect(rankFor(board, 1500)).toBe(3);
    expect(rankFor(board, 500)).toBe(4);
  });

  it('seats a tie below the incumbent', () => {
    // Whoever paid it first keeps the better rank, so matching is not taking.
    expect(rankFor(board, 5000)).toBe(2);
    expect(rankFor(board, 2000)).toBe(3);
  });

  it('agrees with the ordering the board actually renders', () => {
    const bid = listing({ id: 'new', amountCents: 3000, claimedAt: '2026-06-01T00:00:00.000Z' });
    const predicted = rankFor(board, bid.amountCents);
    const actual = rankListings([...board, bid]).findIndex((r) => r.id === 'new') + 1;
    expect(predicted).toBe(actual);
  });

  it('opens at #1 on an empty board', () => {
    expect(rankFor([], entryCents())).toBe(1);
  });
});

describe('board ranking', () => {
  it('orders by money, best paid first', () => {
    const ranked = rankListings([
      listing({ id: 'small', amountCents: 500 }),
      listing({ id: 'big', amountCents: 90_000 }),
      listing({ id: 'mid', amountCents: 4000 }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['big', 'mid', 'small']);
  });

  it('breaks a tie toward whoever paid first', () => {
    const ranked = rankListings([
      listing({ id: 'late', amountCents: 1000, claimedAt: '2026-02-01T00:00:00.000Z' }),
      listing({ id: 'early', amountCents: 1000, claimedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('drops rows that never really paid', () => {
    const ranked = rankListings([
      null as unknown as Listing,
      listing({ id: 'zero', amountCents: 0 }),
      listing({ id: 'nan', amountCents: NaN }),
      listing({ id: 'ok' }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['ok']);
  });

  it('leaves the input array alone', () => {
    const rows = [listing({ id: 'a', amountCents: 100 }), listing({ id: 'b', amountCents: 900 })];
    const order = rows.map((r) => r.id);
    rankListings(rows);
    expect(rows.map((r) => r.id)).toEqual(order);
  });
});

describe('earned side slots', () => {
  it('hands them to the best runs', () => {
    const slots = sideSlots([
      row({ id: 'third', name: 'c', score: 30 }),
      row({ id: 'first', name: 'a', score: 300 }),
      row({ id: 'second', name: 'b', score: 200 }),
      row({ id: 'fourth', name: 'd', score: 10 }),
    ]);
    expect(slots.map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('gives one player at most one slot', () => {
    // A single hot streak should not take the whole rail.
    const slots = sideSlots([
      row({ id: 'best', name: 'ada', score: 900 }),
      row({ id: 'also', name: 'ada', score: 800 }),
      row({ id: 'again', name: 'ADA', score: 700 }),
      row({ id: 'other', name: 'grace', score: 100 }),
    ]);
    expect(slots.map((r) => r.id)).toEqual(['best', 'other']);
  });

  it('never hands out more than there are slots', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, name: `p${i}`, score: i }));
    expect(sideSlots(rows)).toHaveLength(SIDE_SLOTS);
  });

  it('copes with an empty board', () => {
    expect(sideSlots([])).toEqual([]);
  });
});

describe('score ranking', () => {
  it('orders best first', () => {
    const ranked = rankScores([row({ id: 'b', score: 50 }), row({ id: 'a', score: 500 })]);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('breaks ties on the bigger tile, then on who got there first', () => {
    const ranked = rankScores([
      row({ id: 'late', score: 100, bestTile: 64, createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'big', score: 100, bestTile: 256 }),
      row({ id: 'early', score: 100, bestTile: 64, createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['big', 'early', 'late']);
  });

  it('caps the board and leaves the input alone', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ id: `r${i}`, score: i }));
    const order = rows.map((r) => r.id);

    const ranked = rankScores(rows);

    expect(ranked).toHaveLength(LEADERBOARD_LIMIT);
    expect(ranked[0]!.score).toBe(59);
    expect(rows.map((r) => r.id)).toEqual(order);
  });

  it('tolerates junk rows', () => {
    const ranked = rankScores([
      null as unknown as ScoreRow,
      { name: 'no score' } as ScoreRow,
      row({ id: 'ok' }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['ok']);
  });

  it('compareScores is a consistent comparator', () => {
    const a = row({ score: 10 });
    const b = row({ score: 20 });
    expect(compareScores(a, b)).toBeGreaterThan(0);
    expect(compareScores(b, a)).toBeLessThan(0);
    expect(compareScores(a, a)).toBe(0);
  });
});
