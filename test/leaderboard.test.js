import assert from 'node:assert/strict';
import test from 'node:test';

import { STORAGE_KEY, createLeaderboard } from '../src/leaderboard.js';
import { createStorage } from '../src/storage.js';

/** Minimal localStorage stand-in. `fail` makes every call throw. */
function fakeLocalStorage({ fail = false } = {}) {
  const map = new Map();
  return {
    get size() {
      return map.size;
    },
    getItem(key) {
      if (fail) throw new Error('storage disabled');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (fail) throw new Error('storage disabled');
      map.set(key, String(value));
    },
    removeItem(key) {
      if (fail) throw new Error('storage disabled');
      map.delete(key);
    },
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const run = { name: 'Ada', score: 1200, bestTile: 128, moves: 90, durationMs: 30_000 };

test('scores come from the server when it answers', async () => {
  const calls = [];
  const board = createLeaderboard({
    storage: createStorage(fakeLocalStorage()),
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return jsonResponse({ scores: [{ id: 'a', name: 'Ada', score: 999, createdAt: '2024-01-01T00:00:00Z' }] });
    },
  });

  const { entries, source } = await board.list();

  assert.equal(source, 'server');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Ada');
  assert.match(calls[0].url, /^\/api\/scores\?limit=\d+$/);
});

test('submitting posts the run and returns its rank', async () => {
  let posted = null;
  const board = createLeaderboard({
    storage: createStorage(fakeLocalStorage()),
    fetch: async (url, init) => {
      if (init?.method === 'POST') {
        posted = JSON.parse(init.body);
        return jsonResponse(
          {
            entry: { id: 'server-id', ...posted, createdAt: '2024-01-01T00:00:00Z' },
            rank: 1,
            scores: [{ id: 'server-id', name: posted.name, score: posted.score, createdAt: '2024-01-01T00:00:00Z' }],
          },
          { status: 201 },
        );
      }
      return jsonResponse({ scores: [] });
    },
  });

  const result = await board.submit(run);

  assert.equal(result.source, 'server');
  assert.equal(result.rank, 1);
  assert.equal(result.entryId, 'server-id');
  assert.deepEqual(posted, run);
  assert.equal(result.entries[0].score, 1200);
});

test('a missing server falls back to browser storage', async () => {
  const storage = createStorage(fakeLocalStorage());
  const board = createLeaderboard({
    storage,
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });

  const listed = await board.list();
  assert.equal(listed.source, 'local');
  assert.deepEqual(listed.entries, []);

  const saved = await board.submit(run);
  assert.equal(saved.source, 'local');
  assert.equal(saved.rank, 1);
  assert.equal(saved.entries[0].name, 'Ada');
  assert.ok(saved.entryId, 'a local entry still needs an id');

  // and it is actually persisted
  assert.equal(storage.getJSON(STORAGE_KEY).length, 1);
});

test('a server error also falls back rather than losing the run', async () => {
  const board = createLeaderboard({
    storage: createStorage(fakeLocalStorage()),
    fetch: async () => jsonResponse({ error: 'boom' }, { status: 500 }),
  });

  const result = await board.submit(run);

  assert.equal(result.source, 'local');
  assert.equal(result.entries[0].score, 1200);
});

test('a static host with no API falls back instead of erroring', async () => {
  // The page is served, but /api/scores is not a route: 404, 405 and friends
  // mean "no leaderboard here", so the run belongs in local storage.
  for (const status of [404, 405, 410, 501]) {
    const board = createLeaderboard({
      storage: createStorage(fakeLocalStorage()),
      fetch: async () => jsonResponse({ error: 'nope' }, { status }),
    });

    const listed = await board.list();
    assert.equal(listed.source, 'local', `status ${status} should fall back`);

    const saved = await board.submit(run);
    assert.equal(saved.source, 'local', `status ${status} should still save the run`);
    assert.equal(saved.entries[0].score, 1200);
  }
});

test('a non-JSON reply from a static host falls back', async () => {
  const board = createLeaderboard({
    storage: createStorage(fakeLocalStorage()),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      text: async () => '<!DOCTYPE html>',
    }),
  });

  const saved = await board.submit(run);
  assert.equal(saved.source, 'local');
  assert.equal(saved.entries[0].score, 1200);
});

test('a rejected submission surfaces instead of being hidden locally', async () => {
  const board = createLeaderboard({
    storage: createStorage(fakeLocalStorage()),
    fetch: async () => jsonResponse({ error: 'score must be an integer' }, { status: 400 }),
  });

  await assert.rejects(() => board.submit({ score: -1 }), /server responded 400/);
});

test('once local, it stays local for the session', async () => {
  let attempts = 0;
  const board = createLeaderboard({
    storage: createStorage(fakeLocalStorage()),
    fetch: async () => {
      attempts += 1;
      throw new TypeError('Failed to fetch');
    },
  });

  await board.list();
  await board.list();
  await board.submit(run);

  assert.equal(attempts, 1, 'the server should be probed once, not on every call');
  assert.equal(board.source, 'local');
});

test('with no fetch at all the board still works', async () => {
  const board = createLeaderboard({ storage: createStorage(fakeLocalStorage()), fetch: null });

  await board.submit({ ...run, score: 10 });
  const { entries, source } = await board.list();

  assert.equal(source, 'local');
  assert.equal(entries.length, 1);
});

test('local entries are ranked and capped', async () => {
  const board = createLeaderboard({ storage: createStorage(fakeLocalStorage()), fetch: null, limit: 3 });

  for (const score of [100, 500, 300, 900, 50]) {
    await board.submit({ ...run, score });
  }
  const { entries } = await board.list();

  assert.deepEqual(entries.map((row) => row.score), [900, 500, 300]);
});

test('clearing wipes the local board', async () => {
  const storage = createStorage(fakeLocalStorage());
  const board = createLeaderboard({ storage, fetch: null });

  await board.submit(run);
  board.clearLocal();

  const { entries } = await board.list();
  assert.deepEqual(entries, []);
});

test('an invalid local submission is rejected before it is stored', async () => {
  const board = createLeaderboard({ storage: createStorage(fakeLocalStorage()), fetch: null });
  await assert.rejects(() => board.submit({ score: 'not a number' }));
  const { entries } = await board.list();
  assert.deepEqual(entries, []);
});

test('a storage backend is required', () => {
  assert.throws(() => createLeaderboard({ fetch: null }), TypeError);
});

test('the game keeps working when localStorage throws', async () => {
  const storage = createStorage(fakeLocalStorage({ fail: true }));
  assert.equal(storage.persistent, false);

  // Reads and writes are absorbed, never thrown.
  assert.equal(storage.setItem('k', 'v'), true);
  assert.equal(storage.getItem('k'), 'v');
  assert.deepEqual(storage.getJSON('missing', []), []);

  const board = createLeaderboard({ storage, fetch: null });
  const result = await board.submit(run);
  assert.equal(result.rank, 1);
});

test('corrupt stored JSON is discarded, not thrown', () => {
  const backing = fakeLocalStorage();
  backing.setItem('broken', '{not json');
  const storage = createStorage(backing);

  assert.deepEqual(storage.getJSON('broken', 'fallback'), 'fallback');
  assert.equal(storage.getItem('broken'), null, 'the bad value should be cleaned up');
});

test('storage round-trips JSON', () => {
  const storage = createStorage(fakeLocalStorage());
  storage.setJSON('key', { a: 1, b: [2, 3] });
  assert.deepEqual(storage.getJSON('key'), { a: 1, b: [2, 3] });
  storage.removeItem('key');
  assert.equal(storage.getJSON('key'), null);
});
