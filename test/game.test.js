import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECTIONS, Game, createSeededRandom } from '../src/game.js';

/**
 * Build a game with an exact board, bypassing random spawns.
 * `rows` uses 0 for empty cells.
 */
function gameWith(rows, options = {}) {
  const size = rows.length;
  const game = new Game({ size, startTiles: 0, random: () => 0, ...options });
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const value = rows[row][col];
      if (value) game.grid[row][col] = game.createTile(row, col, value);
    }
  }
  return game;
}

/** Move without letting a random tile appear, so assertions stay readable. */
function moveOnly(game, direction) {
  const spawnTile = game.spawnTile;
  game.spawnTile = () => null;
  try {
    return game.move(direction);
  } finally {
    game.spawnTile = spawnTile;
  }
}

test('a new game starts with two tiles worth 2 or 4', () => {
  const game = new Game({ random: createSeededRandom(7) });
  const tiles = game.tiles;
  assert.equal(tiles.length, 2);
  assert.equal(game.score, 0);
  assert.equal(game.moves, 0);
  for (const tile of tiles) {
    assert.ok(tile.value === 2 || tile.value === 4, `unexpected start value ${tile.value}`);
  }
});

test('tiles slide to the far wall without merging', () => {
  const game = gameWith([
    [0, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 4, 0, 0],
    [0, 0, 0, 0],
  ]);

  const result = moveOnly(game, 'left');

  assert.equal(result.moved, true);
  assert.equal(result.scoreGained, 0);
  assert.deepEqual(game.board, [
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [4, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
});

test('two equal tiles merge and the score grows by the new value', () => {
  const game = gameWith([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  const result = moveOnly(game, 'left');

  assert.equal(result.moved, true);
  assert.equal(result.scoreGained, 4);
  assert.equal(game.score, 4);
  assert.deepEqual(game.board[0], [4, 0, 0, 0]);
});

test('a tile merges at most once per move', () => {
  // 2 2 2 2 must become 4 4, never a single 8.
  const game = gameWith([
    [2, 2, 2, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  const result = moveOnly(game, 'left');

  assert.deepEqual(game.board[0], [4, 4, 0, 0]);
  assert.equal(result.scoreGained, 8);
});

test('the pair nearest the wall merges first', () => {
  // 4 4 8 sliding left is 8 8, not 4 (4 8 merged) — merges resolve from the wall.
  const game = gameWith([
    [4, 4, 8, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  moveOnly(game, 'left');

  assert.deepEqual(game.board[0], [8, 8, 0, 0]);
});

test('2 2 4 sliding left merges the twos and keeps the four', () => {
  const game = gameWith([
    [2, 2, 4, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  moveOnly(game, 'left');

  assert.deepEqual(game.board[0], [4, 4, 0, 0]);
});

test('each direction moves tiles the right way', () => {
  const layout = [
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];

  const expected = {
    right: { row: 0, col: 3 },
    down: { row: 3, col: 0 },
    up: { row: 0, col: 0 },
    left: { row: 0, col: 0 },
  };

  for (const direction of DIRECTIONS) {
    const game = gameWith(layout);
    moveOnly(game, direction);
    const tile = game.tiles[0];
    assert.deepEqual(
      { row: tile.row, col: tile.col },
      expected[direction],
      `tile ended in the wrong place moving ${direction}`,
    );
  }
});

test('a move that changes nothing is reported as not moved', () => {
  const game = gameWith([
    [2, 4, 8, 16],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  const before = game.board;
  const result = moveOnly(game, 'up');

  assert.equal(result.moved, false);
  assert.equal(result.scoreGained, 0);
  assert.deepEqual(game.board, before);
  assert.equal(game.moves, 0);
});

test('a successful move spawns exactly one new tile', () => {
  const game = gameWith([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ], { random: createSeededRandom(3) });

  const result = game.move('left');

  assert.equal(result.moved, true);
  assert.ok(result.spawned, 'expected a spawned tile');
  assert.equal(result.spawned.isNew, true);
  assert.equal(game.tiles.length, 2); // the merged 4 plus the spawn
  assert.equal(game.moves, 1);
});

test('a failed move spawns nothing', () => {
  const game = gameWith([
    [2, 4, 8, 16],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  const result = game.move('up');

  assert.equal(result.spawned, null);
  assert.equal(game.tiles.length, 4);
});

test('merged tiles are reported for the renderer with their merge cell', () => {
  const game = gameWith([
    [2, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  const ids = game.tiles.map((tile) => tile.id);
  const result = moveOnly(game, 'left');

  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.removed.map((tile) => tile.id).sort(), ids.sort());
  for (const removed of result.removed) {
    assert.deepEqual({ row: removed.row, col: removed.col }, { row: 0, col: 0 });
  }
  const merged = game.tiles.find((tile) => tile.value === 4);
  assert.ok(merged.mergedFrom, 'merged tile should record its sources');
});

test('surviving tiles remember where they came from', () => {
  const game = gameWith([
    [0, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  moveOnly(game, 'left');

  const tile = game.tiles[0];
  assert.deepEqual(tile.previous, { row: 0, col: 3 });
  assert.equal(tile.isNew, false);
});

test('reaching 2048 reports a win exactly once', () => {
  const game = gameWith([
    [1024, 1024, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  const first = moveOnly(game, 'left');
  assert.equal(first.justWon, true);
  assert.equal(game.won, true);

  const second = moveOnly(game, 'right');
  assert.equal(second.justWon, false, 'the win should only be announced once');
  assert.equal(game.won, true);
});

test('play continues past the winning tile', () => {
  const game = gameWith([
    [1024, 1024, 0, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  moveOnly(game, 'left');
  game.continuePlaying();

  assert.equal(game.keepPlaying, true);
  assert.equal(game.over, false);
  assert.equal(moveOnly(game, 'right').moved, true);
});

test('a full board with no equal neighbours ends the game', () => {
  const game = gameWith([
    [2, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 128],
  ]);

  assert.equal(game.movesAvailable(), false);
  assert.equal(game.isGameOver(), true);
});

test('a full board with an adjacent pair is still playable', () => {
  const game = gameWith([
    [2, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 64],
  ]);

  assert.equal(game.movesAvailable(), true);
  assert.equal(game.isGameOver(), false);
});

test('the game ends when the last move fills the board', () => {
  // The left column slides down into the one free cell, the spawned 2 lands in
  // the corner it vacates, and the resulting board has no equal neighbours.
  const game = gameWith([
    [4, 4, 8, 16],
    [8, 8, 16, 32],
    [16, 16, 32, 64],
    [0, 32, 64, 128],
  ], { random: () => 0 }); // deterministic: first free cell, value 2

  const result = game.move('down');

  assert.equal(result.moved, true);
  assert.equal(result.over, true);
  assert.equal(game.over, true);
  assert.equal(game.move('left').moved, false, 'a finished game accepts no moves');
});

test('an unknown direction is rejected', () => {
  const game = new Game({ random: createSeededRandom(1) });
  assert.throws(() => game.move('sideways'), TypeError);
});

test('board size must be sensible', () => {
  assert.throws(() => new Game({ size: 1 }), RangeError);
  assert.throws(() => new Game({ size: 4.5 }), RangeError);
});

test('other board sizes work', () => {
  const game = new Game({ size: 5, random: createSeededRandom(11) });
  assert.equal(game.board.length, 5);
  assert.equal(game.board[0].length, 5);
  assert.equal(game.tiles.length, 2);
});

test('bestTile reports the largest value on the board', () => {
  const game = gameWith([
    [2, 4, 0, 0],
    [0, 512, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 8],
  ]);
  assert.equal(game.bestTile, 512);
});

test('the same seed replays the same game', () => {
  const play = (seed) => {
    const game = new Game({ random: createSeededRandom(seed) });
    for (const direction of ['left', 'up', 'right', 'down', 'left', 'up']) {
      game.move(direction);
    }
    return { board: game.board, score: game.score };
  };

  assert.deepEqual(play(42), play(42));
  assert.notDeepEqual(play(42).board, play(99).board);
});

test('a game survives a save and restore round trip', () => {
  const original = new Game({ random: createSeededRandom(5) });
  for (const direction of ['left', 'down', 'right', 'up']) {
    original.move(direction);
  }
  original.continuePlaying();

  const restored = Game.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));

  assert.deepEqual(restored.board, original.board);
  assert.equal(restored.score, original.score);
  assert.equal(restored.moves, original.moves);
  assert.equal(restored.won, original.won);
  assert.equal(restored.keepPlaying, original.keepPlaying);
  assert.equal(restored.size, original.size);
});

test('a restored game keeps handing out fresh tile ids', () => {
  const original = new Game({ random: createSeededRandom(8) });
  original.move('left');

  const restored = Game.fromJSON(original.toJSON(), { random: createSeededRandom(8) });
  const existingIds = new Set(restored.tiles.map((tile) => tile.id));
  const spawned = restored.spawnTile();

  assert.ok(spawned, 'expected a free cell');
  assert.equal(existingIds.has(spawned.id), false, 'reused a tile id');
});

test('corrupt snapshots are rejected rather than half-loaded', () => {
  assert.throws(() => Game.fromJSON(null), TypeError);
  assert.throws(() => Game.fromJSON({ size: 4 }), TypeError);
  assert.throws(() => Game.fromJSON({ size: 0, tiles: [] }), TypeError);
  assert.throws(
    () => Game.fromJSON({ size: 4, tiles: [{ id: 1, value: 3, row: 0, col: 0 }] }),
    TypeError,
    'tile values must be powers of two',
  );
  assert.throws(
    () => Game.fromJSON({ size: 4, tiles: [{ id: 1, value: 2, row: 9, col: 0 }] }),
    TypeError,
    'tiles must be on the board',
  );
  assert.throws(
    () =>
      Game.fromJSON({
        size: 4,
        tiles: [
          { id: 1, value: 2, row: 0, col: 0 },
          { id: 2, value: 4, row: 0, col: 0 },
        ],
      }),
    TypeError,
    'two tiles cannot share a cell',
  );
});

test('a restored finished board is marked over', () => {
  const restored = Game.fromJSON({
    size: 2,
    score: 10,
    tiles: [
      { id: 1, value: 2, row: 0, col: 0 },
      { id: 2, value: 4, row: 0, col: 1 },
      { id: 3, value: 8, row: 1, col: 0 },
      { id: 4, value: 16, row: 1, col: 1 },
    ],
  });

  assert.equal(restored.over, true);
});

test('random play never corrupts the board', () => {
  const random = createSeededRandom(2024);
  const game = new Game({ random });

  for (let i = 0; i < 2000 && !game.over; i += 1) {
    game.move(DIRECTIONS[Math.floor(random() * DIRECTIONS.length)]);

    const seen = new Set();
    for (const tile of game.tiles) {
      assert.ok(tile.value >= 2 && (tile.value & (tile.value - 1)) === 0, `bad value ${tile.value}`);
      assert.ok(tile.row >= 0 && tile.row < 4 && tile.col >= 0 && tile.col < 4, 'tile off the board');
      assert.equal(game.grid[tile.row][tile.col], tile, 'grid and tile disagree on position');
      assert.equal(seen.has(tile.id), false, `duplicate tile id ${tile.id}`);
      seen.add(tile.id);
    }
    assert.ok(game.tiles.length <= 16, 'more tiles than cells');
  }

  assert.ok(game.score >= 0);
});
