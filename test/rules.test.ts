import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NAME,
  LEADERBOARD_LIMIT,
  MAX_NAME_LENGTH,
  PODIUM_SIZE,
  compareScores,
  podium,
  rankScores,
  sanitizeName,
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

describe('the podium', () => {
  it('hands the places to the best runs', () => {
    const places = podium([
      row({ id: 'third', name: 'c', score: 30 }),
      row({ id: 'first', name: 'a', score: 300 }),
      row({ id: 'second', name: 'b', score: 200 }),
      row({ id: 'fourth', name: 'd', score: 10 }),
    ]);
    expect(places.map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('gives one player at most one place', () => {
    // A single hot streak should not take the whole podium.
    const places = podium([
      row({ id: 'best', name: 'ada', score: 900 }),
      row({ id: 'also', name: 'ada', score: 800 }),
      row({ id: 'again', name: 'ADA', score: 700 }),
      row({ id: 'other', name: 'grace', score: 100 }),
    ]);
    expect(places.map((r) => r.id)).toEqual(['best', 'other']);
  });

  it('never hands out more places than there are', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, name: `p${i}`, score: i }));
    expect(podium(rows)).toHaveLength(PODIUM_SIZE);
  });

  it('copes with an empty board', () => {
    expect(podium([])).toEqual([]);
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
