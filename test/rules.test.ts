import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NAME,
  LEADERBOARD_LIMIT,
  MAX_BANNER_TEXT,
  MAX_NAME_LENGTH,
  MIN_BID_USD,
  ValidationError,
  compareScores,
  formatCents,
  minimumClaimCents,
  parseUsdToCents,
  rankScores,
  sanitizeBannerText,
  sanitizeBannerUrl,
  sanitizeName,
  type ScoreRow,
} from '../shared/rules.js';

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
    expect(sanitizeName('Ada\u0000\u001bLove')).toBe('Ada Love');
    expect(sanitizeName('two\nlines')).toBe('two lines');
  });

  it('leaves markup as literal text', () => {
    // Names render through textContent, so brackets are just characters.
    expect(sanitizeName('<img src=x>')).toBe('<img src=x>');
  });
});

describe('banner text', () => {
  it('cleans and caps', () => {
    expect(sanitizeBannerText('  buy   my   thing ')).toBe('buy my thing');
    expect(sanitizeBannerText('y'.repeat(300))).toHaveLength(MAX_BANNER_TEXT);
  });

  it('requires something to show', () => {
    for (const input of ['', '    ', '\n\n', undefined, 12]) {
      expect(() => sanitizeBannerText(input)).toThrow(ValidationError);
    }
  });
});

describe('banner links', () => {
  it('accepts a plain https url', () => {
    expect(sanitizeBannerUrl('https://example.com/path?a=1')).toBe('https://example.com/path?a=1');
    expect(sanitizeBannerUrl('  https://example.com  ')).toBe('https://example.com/');
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
      expect(() => sanitizeBannerUrl(input), `should reject ${String(input)}`).toThrow(ValidationError);
    }
  });

  it('rejects credentials in the authority', () => {
    expect(() => sanitizeBannerUrl('https://user:pass@example.com')).toThrow(ValidationError);
  });

  it('requires a real hostname', () => {
    expect(() => sanitizeBannerUrl('https://localhost')).toThrow(ValidationError);
  });

  it('rejects an over-long link', () => {
    expect(() => sanitizeBannerUrl(`https://example.com/${'a'.repeat(400)}`)).toThrow(ValidationError);
  });
});

describe('money', () => {
  it('converts dollars to whole cents', () => {
    expect(parseUsdToCents(5)).toBe(500);
    expect(parseUsdToCents('12.34')).toBe(1234);
    expect(parseUsdToCents(1.005)).toBe(101); // rounds, never floats
  });

  it('enforces a floor and a ceiling', () => {
    expect(() => parseUsdToCents(0)).toThrow(ValidationError);
    expect(() => parseUsdToCents(MIN_BID_USD - 0.01)).toThrow(ValidationError);
    expect(() => parseUsdToCents(-5)).toThrow(ValidationError);
    expect(() => parseUsdToCents(1e9)).toThrow(ValidationError);
    expect(() => parseUsdToCents('abc')).toThrow(ValidationError);
    expect(() => parseUsdToCents(NaN)).toThrow(ValidationError);
    expect(() => parseUsdToCents(Infinity)).toThrow(ValidationError);
  });

  it('formats for display', () => {
    expect(formatCents(1234)).toBe('$12.34');
    expect(formatCents(100)).toBe('$1.00');
  });
});

describe('outbid rules', () => {
  it('opens at the minimum bid', () => {
    expect(minimumClaimCents(null)).toBe(MIN_BID_USD * 100);
    expect(minimumClaimCents(0)).toBe(MIN_BID_USD * 100);
    expect(minimumClaimCents(undefined)).toBe(MIN_BID_USD * 100);
  });

  it('requires beating the standing bid', () => {
    expect(minimumClaimCents(500)).toBe(600);
    // Matching the holder is not enough to take the slot.
    expect(minimumClaimCents(500)).toBeGreaterThan(500);
  });
});

describe('ranking', () => {
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
