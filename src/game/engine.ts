/**
 * Surge — the game engine.
 *
 * Not 2048. You still slide and merge a grid of powers of two, but the board
 * is under constant pressure:
 *
 *   - Rows push in from the bottom on a timer that tightens as you level up,
 *     shoving everything up. A tile forced off the top ends the run.
 *   - Merges chain. Each merge extends a combo window; score is the merged
 *     value times the combo you had going, so speed pays.
 *   - Merging builds charge. A full meter buys a Vent: the bottom row is
 *     blown out and the board drops back down, the exact inverse of a rise.
 *
 * There is no winning tile and no end state but failure — it is a score chase.
 *
 * The engine holds no DOM and reads no clock of its own: every entry point
 * takes `now`, and all chance comes from a seeded RNG. A run is therefore
 * reproducible from `(seed, [(direction, time)...])`, which is what the server
 * replays to verify a submitted score.
 */

import { createRng, randomSeed, type Rng } from './rng.js';
import type {
  Direction,
  GameState,
  Ghost,
  MoveResult,
  RiseEvent,
  Tile,
  TickResult,
  VentResult,
} from './types.js';

export const COLS = 5;
export const ROWS = 5;

/** How long after a merge another merge still counts as a chain. */
export const COMBO_WINDOW_MS = 2600;
export const COMBO_MAX = 9;

/** Rise cadence. Each level multiplies the interval by RISE_DECAY. */
export const RISE_START_MS = 9000;
export const RISE_MIN_MS = 2600;
export const RISE_DECAY = 0.92;

export const MERGES_PER_LEVEL = 12;

/** A full meter buys one Vent. Merging a tile of value V adds log2(V). */
export const CHARGE_MAX = 20;

/** Guard rails for replay: a submitted run may not exceed these. */
export const MAX_MOVES = 20000;
export const MAX_RUN_MS = 2 * 60 * 60 * 1000;

const VECTORS: Record<Direction, { row: number; col: number }> = {
  up: { row: -1, col: 0 },
  right: { row: 0, col: 1 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
};

export interface SurgeOptions {
  seed?: number;
  cols?: number;
  rows?: number;
  /** Tiles placed when the run starts. */
  startTiles?: number;
  /**
   * Feed a tile in after every successful move. On by default: rises alone
   * arrive far too slowly to keep material on the board, and a player who
   * moves quickly would just shuffle the same few tiles with nothing to merge.
   * Tests that assert an exact board turn this off.
   */
  spawnOnMove?: boolean;
}

export class SurgeGame {
  readonly cols: number;
  readonly rows: number;
  readonly seed: number;

  private rng: Rng;
  private grid: (Tile | null)[][] = [];
  private nextId = 1;

  private startTiles: number;
  private spawnOnMove: boolean;

  status: 'idle' | 'playing' | 'over' = 'idle';
  score = 0;
  combo = 1;
  charge = 0;
  merges = 0;
  moves = 0;
  /** Cleared by a vent, re-armed by the next rise. */
  ventArmed = true;

  private startedAt = 0;
  private now = 0;
  private comboExpiresAt = 0;
  private nextRiseAt = 0;

  constructor(options: SurgeOptions = {}) {
    this.cols = options.cols ?? COLS;
    this.rows = options.rows ?? ROWS;
    this.seed = options.seed ?? randomSeed();
    this.startTiles = options.startTiles ?? 4;
    this.spawnOnMove = options.spawnOnMove ?? true;
    this.rng = createRng(this.seed);
    this.resetBoard();
  }

  /** Begin a run. Safe to call again to restart with the same seed. */
  start(now: number): this {
    this.rng = createRng(this.seed);
    this.resetBoard();
    this.status = 'playing';
    this.score = 0;
    this.combo = 1;
    this.charge = 0;
    this.merges = 0;
    this.moves = 0;
    this.ventArmed = true;
    this.startedAt = now;
    this.now = now;
    this.comboExpiresAt = 0;
    this.nextRiseAt = now + this.riseInterval();

    for (let i = 0; i < this.startTiles; i += 1) {
      this.spawnStartTile();
    }
    return this;
  }

  /* ------------------------------------------------------------- queries */

  get level(): number {
    return Math.floor(this.merges / MERGES_PER_LEVEL);
  }

  get tiles(): Tile[] {
    const out: Tile[] = [];
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const tile = this.grid[row]![col];
        if (tile) out.push(tile);
      }
    }
    return out;
  }

  get bestTile(): number {
    return this.tiles.reduce((max, tile) => Math.max(max, tile.value), 0);
  }

  /**
   * A vent needs a full meter *and* an armed valve. The valve re-arms on each
   * rise, which caps vents at one per rise: without that ceiling a fast player
   * earns charge faster than the floor climbs and simply never loses.
   */
  get canVent(): boolean {
    return this.status === 'playing' && this.charge >= CHARGE_MAX && this.ventArmed;
  }

  /** Milliseconds until the next row pushes in. */
  msToRise(now: number = this.now): number {
    return Math.max(0, this.nextRiseAt - now);
  }

  /** How full the rise timer is, 0 → 1. */
  risePressure(now: number = this.now): number {
    const interval = this.riseInterval();
    return clamp01(1 - this.msToRise(now) / interval);
  }

  /** How much of the combo window is left, 1 → 0. */
  comboRemaining(now: number = this.now): number {
    if (this.combo <= 1) return 0;
    return clamp01((this.comboExpiresAt - now) / COMBO_WINDOW_MS);
  }

  /** A plain, serialisable snapshot. This is the agent-facing view. */
  snapshot(now: number = this.now): GameState {
    return {
      status: this.status,
      cols: this.cols,
      rows: this.rows,
      grid: this.grid.map((row) => row.map((tile) => tile?.value ?? 0)),
      tiles: this.tiles.map((tile) => ({ ...tile })),
      score: this.score,
      combo: this.combo,
      comboRemaining: this.comboRemaining(now),
      charge: this.charge,
      chargeMax: CHARGE_MAX,
      canVent: this.canVent,
      ventArmed: this.ventArmed,
      level: this.level,
      merges: this.merges,
      moves: this.moves,
      risePressure: this.risePressure(now),
      msToRise: this.msToRise(now),
      elapsedMs: Math.max(0, now - this.startedAt),
      bestTile: this.bestTile,
      seed: this.seed,
    };
  }

  /* ------------------------------------------------------------ the loop */

  /**
   * Advance time. Applies every rise that has fallen due and expires a stale
   * combo. The renderer calls this each frame; a replay calls it at each move.
   * Both land on the same state because rises are rescheduled from the time
   * they were *due*, never from the moment they were noticed.
   */
  tick(now: number): TickResult {
    const result: TickResult = { rises: [], comboExpired: false, over: this.status === 'over' };
    if (this.status !== 'playing') {
      this.now = now;
      return result;
    }
    this.now = now;

    if (this.combo > 1 && now >= this.comboExpiresAt) {
      this.combo = 1;
      result.comboExpired = true;
    }

    let guard = 0;
    while (this.status === 'playing' && now >= this.nextRiseAt) {
      const dueAt = this.nextRiseAt;
      const rise = this.applyRise();
      result.rises.push(rise);
      // Reschedule from the due time so frame-rate and replay agree exactly.
      this.nextRiseAt = dueAt + this.riseInterval();

      if (rise.crushed) {
        this.status = 'over';
        result.over = true;
        break;
      }
      // A pathological gap in timestamps must not spin forever.
      guard += 1;
      if (guard > 512) {
        this.nextRiseAt = now + this.riseInterval();
        break;
      }
    }

    result.over = this.status === 'over';
    return result;
  }

  /**
   * Slide the board. Ticks first, so waiting too long between moves costs you
   * the rows you earned.
   */
  move(direction: Direction, now: number): MoveResult {
    const empty: MoveResult = {
      moved: false,
      merges: 0,
      scoreGained: 0,
      comboApplied: this.combo,
      removed: [],
      spawned: null,
      leveledUp: false,
      over: this.status === 'over',
    };

    const vector = VECTORS[direction];
    if (!vector) throw new TypeError(`unknown direction "${direction}"`);

    this.tick(now);
    if (this.status !== 'playing') return { ...empty, over: this.status === 'over' };

    const levelBefore = this.level;
    const removed: Ghost[] = [];
    let moved = false;
    let mergeCount = 0;
    let mergedValueTotal = 0;
    let chargeGained = 0;

    for (const tile of this.tiles) {
      tile.previous = { row: tile.row, col: tile.col };
      tile.mergedFrom = null;
      tile.origin = null;
    }

    const traversals = buildTraversals(vector, this.rows, this.cols);
    for (const row of traversals.rows) {
      for (const col of traversals.cols) {
        const tile = this.grid[row]![col];
        if (!tile) continue;

        const { farthest, next } = this.findFarthest({ row, col }, vector);
        const target = next ? this.grid[next.row]![next.col] : null;

        if (target && target.value === tile.value && !target.mergedFrom) {
          const merged = this.createTile(next!.row, next!.col, tile.value * 2);
          merged.mergedFrom = [tile.id, target.id];
          merged.origin = 'merge';
          merged.previous = null;

          this.grid[tile.row]![tile.col] = null;
          this.grid[next!.row]![next!.col] = merged;

          removed.push({ ...toGhost(tile, 'merge'), row: next!.row, col: next!.col });
          removed.push(toGhost(target, 'merge'));

          mergeCount += 1;
          mergedValueTotal += merged.value;
          chargeGained += Math.log2(merged.value);
          moved = true;
        } else if (farthest.row !== tile.row || farthest.col !== tile.col) {
          this.grid[tile.row]![tile.col] = null;
          tile.row = farthest.row;
          tile.col = farthest.col;
          this.grid[tile.row]![tile.col] = tile;
          moved = true;
        }
      }
    }

    if (!moved) return { ...empty, comboApplied: this.combo };

    this.moves += 1;

    // Merges score at the combo you walked in with; the combo then climbs by
    // however many merges landed, so a multi-merge move is worth setting up.
    const comboApplied = this.combo;
    let scoreGained = 0;
    if (mergeCount > 0) {
      scoreGained = mergedValueTotal * comboApplied;
      this.score += scoreGained;
      this.merges += mergeCount;
      this.charge = Math.min(CHARGE_MAX, this.charge + chargeGained);
      this.combo = Math.min(COMBO_MAX, this.combo + mergeCount);
      this.comboExpiresAt = now + COMBO_WINDOW_MS;
    }

    const spawned = this.spawnOnMove ? this.spawnAfterMove() : null;

    return {
      moved: true,
      merges: mergeCount,
      scoreGained,
      comboApplied,
      removed,
      spawned,
      leveledUp: this.level > levelBefore,
      over: false,
    };
  }

  /**
   * Spend a full charge meter to blow out the bottom row and drop the board
   * back down — the inverse of a rise.
   *
   * Deliberately does NOT touch the rise timer. It used to, and that made the
   * game unlosable: a fast player earns charge faster than the interval
   * shrinks, so resetting the clock on every vent stalled the floor forever.
   * The vent buys space, never time — which is also why spending it early is
   * better than holding it for a last-second rescue.
   */
  vent(now: number): VentResult {
    this.tick(now);
    if (!this.canVent) return { vented: false, removed: [] };

    const removed: Ghost[] = [];
    const bottom = this.rows - 1;

    for (let col = 0; col < this.cols; col += 1) {
      const tile = this.grid[bottom]![col];
      if (tile) removed.push(toGhost(tile, 'vent'));
    }

    // Shift every row down one; the top row is left empty.
    for (let row = this.rows - 1; row > 0; row -= 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const above = this.grid[row - 1]![col] ?? null;
        this.grid[row]![col] = above;
        if (above) {
          above.previous = { row: above.row, col: above.col };
          above.row = row;
          above.mergedFrom = null;
          above.origin = null;
        }
      }
    }
    for (let col = 0; col < this.cols; col += 1) {
      this.grid[0]![col] = null;
    }

    this.charge = 0;
    this.ventArmed = false;
    return { vented: true, removed };
  }

  /* ------------------------------------------------------------ internals */

  /** Current gap between rises, tightening with each level. */
  private riseInterval(): number {
    return Math.max(RISE_MIN_MS, RISE_START_MS * Math.pow(RISE_DECAY, this.level));
  }

  /** How many tiles a rising row brings, and how big they can be. */
  private riseWidth(): number {
    return Math.min(this.cols - 1, 2 + Math.floor(this.level / 4));
  }

  private riseValue(): number {
    // Mostly 2s, with 4s and later 8s mixed in as the run matures.
    const roll = this.rng.next();
    if (this.level >= 8 && roll > 0.9) return 8;
    if (roll > 0.72) return 4;
    return 2;
  }

  /** Push a partial row in along the bottom, shoving everything up one. */
  private applyRise(): RiseEvent {
    const removed: Ghost[] = [];
    let crushed = false;

    // Anything still in the top row has nowhere to go.
    for (let col = 0; col < this.cols; col += 1) {
      const tile = this.grid[0]![col];
      if (tile) {
        crushed = true;
        removed.push(toGhost(tile, 'crush'));
      }
    }

    for (let row = 0; row < this.rows - 1; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const below = this.grid[row + 1]![col] ?? null;
        this.grid[row]![col] = below;
        if (below) {
          below.previous = { row: below.row, col: below.col };
          below.row = row;
          below.mergedFrom = null;
          below.origin = null;
        }
      }
    }

    const bottom = this.rows - 1;
    for (let col = 0; col < this.cols; col += 1) {
      this.grid[bottom]![col] = null;
    }

    this.ventArmed = true;

    const spawned: Tile[] = [];
    if (!crushed) {
      const columns = shuffle(range(this.cols), this.rng).slice(0, this.riseWidth());
      for (const col of columns) {
        const tile = this.createTile(bottom, col, this.riseValue());
        tile.origin = 'rise';
        this.grid[bottom]![col] = tile;
        spawned.push(tile);
      }
    }

    return { spawned, crushed, removed };
  }

  /**
   * Feed one tile in after a move.
   *
   * It lands in the lowest row with space, so new material always arrives from
   * underneath you — consistent with the rising floor — and a move can never
   * put a tile into the danger row itself.
   */
  private spawnAfterMove(): Tile | null {
    for (let row = this.rows - 1; row >= 1; row -= 1) {
      const free: number[] = [];
      for (let col = 0; col < this.cols; col += 1) {
        if (!this.grid[row]![col]) free.push(col);
      }
      if (free.length === 0) continue;

      const col = this.rng.pick(free)!;
      const tile = this.createTile(row, col, this.rng.next() > 0.85 ? 4 : 2);
      tile.origin = 'spawn';
      this.grid[row]![col] = tile;
      return tile;
    }
    return null;
  }

  private spawnStartTile(): Tile | null {
    // Start tiles never occupy the top row — the run should not open in danger.
    const cells: { row: number; col: number }[] = [];
    for (let row = 1; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        if (!this.grid[row]![col]) cells.push({ row, col });
      }
    }
    const cell = this.rng.pick(cells);
    if (!cell) return null;

    const tile = this.createTile(cell.row, cell.col, this.rng.next() > 0.8 ? 4 : 2);
    tile.origin = 'start';
    this.grid[cell.row]![cell.col] = tile;
    return tile;
  }

  private resetBoard(): void {
    this.grid = Array.from({ length: this.rows }, () => new Array<Tile | null>(this.cols).fill(null));
    this.nextId = 1;
  }

  private createTile(row: number, col: number, value: number): Tile {
    return {
      id: this.nextId++,
      value,
      row,
      col,
      previous: null,
      mergedFrom: null,
      origin: null,
    };
  }

  private findFarthest(
    cell: { row: number; col: number },
    vector: { row: number; col: number },
  ): { farthest: { row: number; col: number }; next: { row: number; col: number } | null } {
    let previous = cell;
    let current = { row: cell.row + vector.row, col: cell.col + vector.col };
    while (this.inBounds(current) && !this.grid[current.row]![current.col]) {
      previous = current;
      current = { row: current.row + vector.row, col: current.col + vector.col };
    }
    return { farthest: previous, next: this.inBounds(current) ? current : null };
  }

  private inBounds({ row, col }: { row: number; col: number }): boolean {
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }
}

/* ---------------------------------------------------------------- helpers */

function toGhost(tile: Tile, reason: Ghost['reason']): Ghost {
  return {
    id: tile.id,
    value: tile.value,
    row: tile.row,
    col: tile.col,
    previous: tile.previous ? { ...tile.previous } : null,
    reason,
  };
}

/** Traverse the wall a move pushes toward first, so tiles pile up correctly. */
function buildTraversals(
  vector: { row: number; col: number },
  rows: number,
  cols: number,
): { rows: number[]; cols: number[] } {
  const rowOrder = range(rows);
  const colOrder = range(cols);
  if (vector.row === 1) rowOrder.reverse();
  if (vector.col === 1) colOrder.reverse();
  return { rows: rowOrder, cols: colOrder };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
