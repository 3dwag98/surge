import { describe, expect, it } from 'vitest';

import {
  CHARGE_MAX,
  CHARGE_SURGE,
  COMBO_MAX,
  COMBO_WINDOW_MS,
  MERGES_PER_LEVEL,
  RISE_START_MS,
  SurgeGame,
} from '../src/game/engine.js';
import type { Direction } from '../src/game/types.js';

/** A game with an exact board, bypassing the opening spawn. */
function boardOf(rows: number[][], seed = 1): SurgeGame {
  const game = new SurgeGame({ seed, startTiles: 0, spawnOnMove: false, rows: rows.length, cols: rows[0]!.length });
  game.start(0);
  setBoard(game, rows);
  return game;
}

function setBoard(game: SurgeGame, rows: number[][]): void {
  const grid = (game as unknown as { grid: unknown[][] }).grid;
  const create = (game as unknown as { createTile(r: number, c: number, v: number): unknown });
  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < rows[row]!.length; col += 1) {
      const value = rows[row]![col]!;
      grid[row]![col] = value ? create.createTile(row, col, value) : null;
    }
  }
}

const values = (game: SurgeGame) => game.snapshot().grid;

/** Keep the rise timer out of the way while testing slide mechanics. */
const NO_RISE = 1;

describe('sliding and merging', () => {
  it('slides tiles to the far wall', () => {
    const game = boardOf([
      [0, 0, 0, 0, 2],
      [0, 0, 0, 0, 0],
      [0, 4, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    const result = game.move('left', NO_RISE);

    expect(result.moved).toBe(true);
    expect(values(game)[0]).toEqual([2, 0, 0, 0, 0]);
    expect(values(game)[2]).toEqual([4, 0, 0, 0, 0]);
  });

  it('merges equal tiles and scores the merged value', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 2, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    const result = game.move('left', NO_RISE);

    expect(result.merges).toBe(1);
    expect(result.scoreGained).toBe(4); // 4 x combo 1
    expect(game.score).toBe(4);
    expect(values(game)[1]![0]).toBe(4);
  });

  it('never merges a tile twice in one move', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 2, 2, 2, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    const result = game.move('left', NO_RISE);

    expect(values(game)[1]).toEqual([4, 4, 0, 0, 0]);
    expect(result.merges).toBe(2);
  });

  it('resolves the pair nearest the wall first', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [4, 4, 8, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    game.move('left', NO_RISE);

    expect(values(game)[1]).toEqual([8, 8, 0, 0, 0]);
  });

  it('reports a move that changes nothing', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [2, 4, 8, 16, 32],
    ]);

    const result = game.move('down', NO_RISE);

    expect(result.moved).toBe(false);
    expect(game.moves).toBe(0);
  });

  it('rejects an unknown direction', () => {
    const game = boardOf([[2, 0], [0, 0]]);
    expect(() => game.move('sideways' as Direction, NO_RISE)).toThrow(TypeError);
  });
});

describe('combo scoring', () => {
  it('starts at one and climbs with each merge', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 2, 0, 0, 0],
      [4, 4, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    // Two merges in one move: both score at combo 1, then combo jumps to 3.
    const first = game.move('left', NO_RISE);
    expect(first.merges).toBe(2);
    expect(first.comboApplied).toBe(1);
    expect(first.scoreGained).toBe(4 + 8);
    expect(game.combo).toBe(3);
  });

  it('scores the next merge at the banked multiplier', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 2, 0, 0, 0],
      [4, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    game.move('left', NO_RISE); // the pair of 2s merges -> combo 2
    expect(game.combo).toBe(2);
    expect(game.score).toBe(4);

    // Column 0 now holds 4 over 4; sliding up merges them at the banked combo.
    const second = game.move('up', 500); // still inside the window
    expect(second.merges).toBe(1);
    expect(second.comboApplied).toBe(2);
    expect(second.scoreGained).toBe(8 * 2);
  });

  it('decays back to one when the window lapses', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 2, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    game.move('left', NO_RISE);
    expect(game.combo).toBe(2);

    const tick = game.tick(NO_RISE + COMBO_WINDOW_MS + 1);

    expect(tick.comboExpired).toBe(true);
    expect(game.combo).toBe(1);
  });

  it('is capped', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 2, 2, 2, 0],
      [2, 2, 2, 2, 0],
      [2, 2, 2, 2, 0],
      [2, 2, 2, 2, 0],
    ]);

    for (let i = 0; i < 6; i += 1) {
      game.move(i % 2 === 0 ? 'left' : 'right', NO_RISE + i * 100);
    }

    expect(game.combo).toBeLessThanOrEqual(COMBO_MAX);
  });

  it('reports the remaining window as a fraction', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 2, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    game.move('left', 0);
    expect(game.comboRemaining(0)).toBeCloseTo(1, 5);
    expect(game.comboRemaining(COMBO_WINDOW_MS / 2)).toBeCloseTo(0.5, 5);
    expect(game.comboRemaining(COMBO_WINDOW_MS * 2)).toBe(0);
  });
});

describe('rising rows', () => {
  it('pushes the board up and adds tiles along the bottom', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
    ]);

    const tick = game.tick(RISE_START_MS);

    expect(tick.rises).toHaveLength(1);
    expect(tick.over).toBe(false);
    expect(values(game)[3]![0]).toBe(2); // the 2 moved up a row
    expect(tick.rises[0]!.spawned.length).toBeGreaterThan(0);
  });

  it('ends the run when a tile is pushed off the top', () => {
    const game = boardOf([
      [2, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    const tick = game.tick(RISE_START_MS);

    expect(tick.over).toBe(true);
    expect(game.status).toBe('over');
    expect(tick.rises[0]!.crushed).toBe(true);
  });

  it('refuses further moves once the run is over', () => {
    const game = boardOf([
      [2, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    game.tick(RISE_START_MS);
    const result = game.move('left', RISE_START_MS + 10);

    expect(result.moved).toBe(false);
    expect(result.over).toBe(true);
  });

  it('applies every rise that fell due during a long gap', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    const tick = game.tick(RISE_START_MS * 3.5);

    expect(tick.rises.length).toBeGreaterThanOrEqual(3);
  });

  it('schedules from the due time, so frame rate cannot change the outcome', () => {
    const everyFrame = boardOf([[0, 0], [0, 0]], 7);
    const oneJump = boardOf([[0, 0], [0, 0]], 7);

    // One game ticked 16ms at a time, the other in a single leap.
    for (let t = 0; t <= RISE_START_MS * 2.2; t += 16) everyFrame.tick(t);
    everyFrame.tick(RISE_START_MS * 2.2);
    oneJump.tick(RISE_START_MS * 2.2);

    expect(everyFrame.snapshot().grid).toEqual(oneJump.snapshot().grid);
    expect(everyFrame.msToRise(RISE_START_MS * 2.2)).toBeCloseTo(
      oneJump.msToRise(RISE_START_MS * 2.2),
      5,
    );
  });

  it('reports rise pressure as a fraction', () => {
    const game = new SurgeGame({ seed: 3 });
    game.start(0);

    expect(game.risePressure(0)).toBeCloseTo(0, 5);
    expect(game.risePressure(RISE_START_MS / 2)).toBeCloseTo(0.5, 2);
  });

  it('speeds up as the level climbs', () => {
    const game = new SurgeGame({ seed: 4 });
    game.start(0);
    const baseInterval = game.msToRise(0);

    // Bank enough merges for a higher level, then let a rise fire: the gap it
    // schedules next is the one that should have tightened.
    (game as unknown as { merges: number }).merges = MERGES_PER_LEVEL * 5;
    game.tick(baseInterval);

    expect(game.level).toBe(5);
    expect(game.status).toBe('playing');
    expect(game.msToRise(baseInterval)).toBeLessThan(baseInterval);
  });
});

describe('charge and venting', () => {
  it('will not vent without a full meter', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
    ]);

    expect(game.canVent).toBe(false);
    expect(game.vent(NO_RISE).vented).toBe(false);
  });

  it('builds charge from merges', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [8, 8, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);

    game.move('left', NO_RISE);

    expect(game.charge).toBeCloseTo(Math.log2(16), 5);
  });

  it('drops the board back down, the inverse of a rise', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
      [0, 4, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 8],
    ]);
    (game as unknown as { charge: number }).charge = CHARGE_MAX;

    const result = game.vent(NO_RISE);

    expect(result.vented).toBe(true);
    expect(result.rows).toBe(1);
    expect(result.removed.map((ghost) => ghost.value)).toEqual([8]);
    expect(values(game)[0]).toEqual([0, 0, 0, 0, 0]); // top row cleared
    expect(values(game)[2]![0]).toBe(2); // everything fell one row
    expect(values(game)[3]![1]).toBe(4);
    expect(game.charge).toBe(0);
  });

  it('overcharges into a Surge that clears two rows', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
      [0, 4, 0, 0, 0],
      [16, 0, 0, 0, 0],
      [0, 0, 0, 0, 8],
    ]);
    (game as unknown as { charge: number }).charge = CHARGE_SURGE;
    expect(game.canSurge).toBe(true);

    const result = game.vent(NO_RISE);

    expect(result.vented).toBe(true);
    expect(result.rows).toBe(2);
    // Both of the bottom two rows went, not just the floor.
    expect(result.removed.map((ghost) => ghost.value).sort()).toEqual([16, 8]);
    expect(values(game)[0]).toEqual([0, 0, 0, 0, 0]);
    expect(values(game)[1]).toEqual([0, 0, 0, 0, 0]);
    expect(values(game)[3]![0]).toBe(2); // everything fell two rows
    expect(values(game)[4]![1]).toBe(4);
    expect(game.charge).toBe(0);
  });

  it('a merely full meter is still worth one row, not two', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
      [0, 0, 0, 0, 4],
    ]);
    (game as unknown as { charge: number }).charge = CHARGE_SURGE - 1;
    expect(game.canVent).toBe(true);
    expect(game.canSurge).toBe(false);

    expect(game.vent(NO_RISE).rows).toBe(1);
    expect(values(game)[4]![0]).toBe(2); // the 2 fell exactly one row
  });

  it('a Surge is still one vent: it does not re-arm the valve', () => {
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
    ]);
    (game as unknown as { charge: number }).charge = CHARGE_SURGE;

    expect(game.vent(NO_RISE).rows).toBe(2);
    // Refilling the meter in the same window buys nothing until the next rise.
    (game as unknown as { charge: number }).charge = CHARGE_SURGE;
    expect(game.canVent).toBe(false);
    expect(game.canSurge).toBe(false);
    expect(game.vent(NO_RISE).vented).toBe(false);
  });

  it('buys space but never time', () => {
    // Venting must not push the rise timer back: charge is earned faster than
    // the interval shrinks, so a vent that reset the clock would make the game
    // unlosable for anyone merging quickly.
    const game = boardOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
    ]);
    (game as unknown as { charge: number }).charge = CHARGE_MAX;

    const at = RISE_START_MS - 100;
    game.vent(at);

    expect(game.msToRise(at)).toBeCloseTo(100, 0);
  });

  it('cannot be used to stall the floor forever', () => {
    // Merge relentlessly and vent the instant it is available; the floor must
    // still bury the run.
    const game = new SurgeGame({ seed: 77 });
    game.start(0);

    let now = 0;
    for (let i = 0; i < 6000 && game.status === 'playing'; i += 1) {
      now += 15; // far faster than a human could ever play
      if (game.canVent) game.vent(now);
      game.move((['down', 'left', 'right', 'up'] as const)[i % 4]!, now);
    }

    expect(game.status).toBe('over');
  });
});

describe('determinism', () => {
  it('replays identically from the same seed', () => {
    const play = (seed: number) => {
      const game = new SurgeGame({ seed });
      game.start(0);
      const script: Direction[] = ['left', 'down', 'right', 'up', 'left', 'down'];
      script.forEach((direction, i) => game.move(direction, i * 400));
      game.tick(10_000);
      return game.snapshot(10_000);
    };

    expect(play(1234)).toEqual(play(1234));
    expect(play(1234).grid).not.toEqual(play(9876).grid);
  });

  it('exposes a serialisable snapshot', () => {
    const game = new SurgeGame({ seed: 21 });
    game.start(0);
    const snapshot = game.snapshot(0);

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.grid).toHaveLength(5);
    expect(snapshot.grid[0]).toHaveLength(5);
    expect(snapshot.status).toBe('playing');
    expect(snapshot.seed).toBe(21);
  });

  it('opens with tiles clear of the top row', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const game = new SurgeGame({ seed });
      game.start(0);
      expect(game.snapshot().grid[0]).toEqual([0, 0, 0, 0, 0]);
    }
  });
});

describe('long random play', () => {
  it('keeps the board coherent until the run ends', () => {
    const game = new SurgeGame({ seed: 2024 });
    game.start(0);
    const directions: Direction[] = ['up', 'right', 'down', 'left'];

    let now = 0;
    for (let i = 0; i < 3000 && game.status === 'playing'; i += 1) {
      now += 120;
      game.move(directions[i % 4]!, now);
      if (game.canVent && i % 7 === 0) game.vent(now);

      const snapshot = game.snapshot(now);
      const seen = new Set<number>();
      for (const tile of snapshot.tiles) {
        expect(tile.value).toBeGreaterThanOrEqual(2);
        expect(tile.value & (tile.value - 1)).toBe(0);
        expect(tile.row).toBeGreaterThanOrEqual(0);
        expect(tile.row).toBeLessThan(5);
        expect(seen.has(tile.id)).toBe(false);
        seen.add(tile.id);
        expect(snapshot.grid[tile.row]![tile.col]).toBe(tile.value);
      }
      expect(snapshot.score).toBeGreaterThanOrEqual(0);
      expect(snapshot.charge).toBeLessThanOrEqual(CHARGE_SURGE);
    }

    expect(game.status).toBe('over');
  });
});
