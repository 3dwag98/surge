import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_NAME,
  LEADERBOARD_LIMIT,
  MAX_NAME_LENGTH,
  MAX_SCORE,
  ValidationError,
  insertEntry,
  normalizeEntry,
  qualifies,
  rankEntries,
  sanitizeName,
} from '../src/scores.js';

const options = { now: () => Date.parse('2024-01-01T00:00:00Z'), id: () => 'fixed-id' };

function entry(overrides = {}) {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    name: 'Player',
    score: 100,
    bestTile: 128,
    moves: 50,
    durationMs: 1000,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

test('names are trimmed, collapsed and capped', () => {
  assert.equal(sanitizeName('  Ada  '), 'Ada');
  assert.equal(sanitizeName('Ada   Lovelace'), 'Ada Lovelace');
  assert.equal(sanitizeName('x'.repeat(50)).length, MAX_NAME_LENGTH);
});

test('unusable names fall back to a default', () => {
  assert.equal(sanitizeName(''), DEFAULT_NAME);
  assert.equal(sanitizeName('   '), DEFAULT_NAME);
  assert.equal(sanitizeName(undefined), DEFAULT_NAME);
  assert.equal(sanitizeName(42), DEFAULT_NAME);
  assert.equal(sanitizeName(null), DEFAULT_NAME);
});

test('control characters are stripped from names', () => {
  assert.equal(sanitizeName('Ada\u0000\u001bLove'), 'Ada Love');
  assert.equal(sanitizeName('line\nbreak'), 'line break');
  assert.equal(sanitizeName('\u0007'), DEFAULT_NAME);
});

test('markup in a name is left as plain text, not escaped', () => {
  // The UI writes names with textContent, so angle brackets are just characters.
  assert.equal(sanitizeName('<b>hi</b>'), '<b>hi</b>');
});

test('a valid entry is normalized with server-side fields', () => {
  const normalized = normalizeEntry(
    { name: 'Ada', score: 2048, bestTile: 256, moves: 300, durationMs: 60_000 },
    options,
  );

  assert.deepEqual(normalized, {
    id: 'fixed-id',
    name: 'Ada',
    score: 2048,
    bestTile: 256,
    moves: 300,
    durationMs: 60_000,
    createdAt: '2024-01-01T00:00:00.000Z',
  });
});

test('optional fields default rather than fail', () => {
  const normalized = normalizeEntry({ score: 10 }, options);
  assert.equal(normalized.name, DEFAULT_NAME);
  assert.equal(normalized.bestTile, 0);
  assert.equal(normalized.moves, 0);
  assert.equal(normalized.durationMs, 0);
});

test('numeric strings from a form are accepted', () => {
  const normalized = normalizeEntry({ score: '512', moves: '20', bestTile: '64' }, options);
  assert.equal(normalized.score, 512);
  assert.equal(normalized.moves, 20);
  assert.equal(normalized.bestTile, 64);
});

test('bad entries are rejected', () => {
  const bad = [
    null,
    'nope',
    {},
    { score: -1 },
    { score: 1.5 },
    { score: NaN },
    { score: Infinity },
    { score: MAX_SCORE + 1 },
    { score: '' },
    { score: 'abc' },
    { score: 100, moves: -5 },
    { score: 100, bestTile: 3 },
    { score: 100, bestTile: -8 },
    { score: 100, bestTile: 2 ** 30 },
  ];

  for (const raw of bad) {
    assert.throws(() => normalizeEntry(raw, options), ValidationError, `should reject ${JSON.stringify(raw)}`);
  }
});

test('entries rank by score, then tile, then who got there first', () => {
  const ranked = rankEntries([
    entry({ id: 'c', score: 100, bestTile: 128, createdAt: '2024-01-02T00:00:00Z' }),
    entry({ id: 'a', score: 300 }),
    entry({ id: 'b', score: 100, bestTile: 256 }),
    entry({ id: 'd', score: 100, bestTile: 128, createdAt: '2024-01-01T00:00:00Z' }),
  ]);

  assert.deepEqual(ranked.map((row) => row.id), ['a', 'b', 'd', 'c']);
});

test('ranking trims to the limit and leaves the input alone', () => {
  const entries = Array.from({ length: 25 }, (_, i) => entry({ id: `e${i}`, score: i }));
  const snapshot = entries.map((row) => row.id);

  const ranked = rankEntries(entries);

  assert.equal(ranked.length, LEADERBOARD_LIMIT);
  assert.equal(ranked[0].score, 24);
  assert.deepEqual(entries.map((row) => row.id), snapshot, 'rankEntries must not reorder its input');
});

test('ranking tolerates junk in the stored list', () => {
  const ranked = rankEntries([null, undefined, { name: 'no score' }, entry({ id: 'ok' })]);
  assert.deepEqual(ranked.map((row) => row.id), ['ok']);
});

test('rankEntries copes with a non-array', () => {
  assert.deepEqual(rankEntries(undefined), []);
  assert.deepEqual(rankEntries('nope'), []);
});

test('inserting reports the new rank', () => {
  const existing = [entry({ id: 'a', score: 500 }), entry({ id: 'b', score: 100 })];
  const { entries, rank } = insertEntry(existing, entry({ id: 'new', score: 300 }));

  assert.equal(rank, 2);
  assert.deepEqual(entries.map((row) => row.id), ['a', 'new', 'b']);
});

test('an entry that misses the cut reports no rank', () => {
  const full = Array.from({ length: LEADERBOARD_LIMIT }, (_, i) => entry({ id: `e${i}`, score: 1000 + i }));
  const { entries, rank } = insertEntry(full, entry({ id: 'low', score: 1 }));

  assert.equal(rank, null);
  assert.equal(entries.length, LEADERBOARD_LIMIT);
  assert.equal(entries.some((row) => row.id === 'low'), false);
});

test('qualifying needs a real score and a free slot or a better one', () => {
  const full = Array.from({ length: LEADERBOARD_LIMIT }, (_, i) => entry({ id: `e${i}`, score: 100 + i }));

  assert.equal(qualifies([], 10), true, 'an empty board takes anything positive');
  assert.equal(qualifies([], 0), false, 'a zero score never places');
  assert.equal(qualifies([], -5), false);
  assert.equal(qualifies(full, 50), false, 'below the last place');
  assert.equal(qualifies(full, 5000), true);
  assert.equal(qualifies(full, 100), false, 'a tie with last place does not displace it');
});
