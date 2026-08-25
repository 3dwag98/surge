/**
 * 2048 game engine.
 *
 * Pure logic with no DOM access, so it can be unit tested and driven by any
 * renderer. Randomness is injected, which makes every game reproducible.
 */

export const DIRECTIONS = ['up', 'right', 'down', 'left'];

const VECTORS = {
  up: { row: -1, col: 0 },
  right: { row: 0, col: 1 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
};

export const DEFAULT_SIZE = 4;
export const WINNING_VALUE = 2048;

/** Probability that a spawned tile is a 2 rather than a 4. */
const SPAWN_TWO_PROBABILITY = 0.9;

export class Game {
  /**
   * @param {object} [options]
   * @param {number} [options.size] Board edge length.
   * @param {() => number} [options.random] Source of randomness in [0, 1).
   * @param {number} [options.startTiles] Tiles placed on a fresh board.
   * @param {number} [options.winningValue] Tile value that counts as a win.
   */
  constructor({
    size = DEFAULT_SIZE,
    random = Math.random,
    startTiles = 2,
    winningValue = WINNING_VALUE,
  } = {}) {
    if (!Number.isInteger(size) || size < 2) {
      throw new RangeError(`size must be an integer >= 2, got ${size}`);
    }
    this.size = size;
    this.random = random;
    this.startTiles = startTiles;
    this.winningValue = winningValue;
    this.reset();
  }

  /** Start a brand new game on an empty board. */
  reset() {
    this.grid = Array.from({ length: this.size }, () => new Array(this.size).fill(null));
    this.score = 0;
    this.moves = 0;
    this.won = false;
    this.keepPlaying = false;
    this.over = false;
    this.nextId = 1;
    for (let i = 0; i < this.startTiles; i += 1) {
      this.spawnTile();
    }
    return this;
  }

  /** Every tile currently on the board, in row-major order. */
  get tiles() {
    const tiles = [];
    for (let row = 0; row < this.size; row += 1) {
      for (let col = 0; col < this.size; col += 1) {
        const tile = this.grid[row][col];
        if (tile) tiles.push(tile);
      }
    }
    return tiles;
  }

  /** The board as a plain 2D array of numbers, with 0 for empty cells. */
  get board() {
    return this.grid.map((row) => row.map((tile) => (tile ? tile.value : 0)));
  }

  /** Largest tile value on the board. */
  get bestTile() {
    return this.tiles.reduce((max, tile) => Math.max(max, tile.value), 0);
  }

  /** Cells with no tile on them. */
  availableCells() {
    const cells = [];
    for (let row = 0; row < this.size; row += 1) {
      for (let col = 0; col < this.size; col += 1) {
        if (!this.grid[row][col]) cells.push({ row, col });
      }
    }
    return cells;
  }

  /**
   * Place a random tile (2 with 90% chance, otherwise 4) on a random free cell.
   * @returns {object|null} The new tile, or null when the board is full.
   */
  spawnTile() {
    const cells = this.availableCells();
    if (cells.length === 0) return null;
    const cell = cells[Math.floor(this.random() * cells.length)];
    const value = this.random() < SPAWN_TWO_PROBABILITY ? 2 : 4;
    const tile = this.createTile(cell.row, cell.col, value);
    tile.isNew = true;
    this.grid[cell.row][cell.col] = tile;
    return tile;
  }

  /**
   * Slide and merge every tile one step in `direction`.
   *
   * @param {'up'|'right'|'down'|'left'} direction
   * @returns {{moved: boolean, scoreGained: number, spawned: object|null,
   *            removed: object[], justWon: boolean, over: boolean}}
   */
  move(direction) {
    const vector = VECTORS[direction];
    if (!vector) {
      throw new TypeError(`unknown direction "${direction}"`);
    }

    const result = {
      moved: false,
      scoreGained: 0,
      spawned: null,
      removed: [],
      justWon: false,
      over: this.over,
    };
    if (this.over) return result;

    // Remember where each tile started so the renderer can animate the slide.
    for (const tile of this.tiles) {
      tile.previous = { row: tile.row, col: tile.col };
      tile.mergedFrom = null;
      tile.isNew = false;
    }

    const traversals = buildTraversals(vector, this.size);
    for (const row of traversals.rows) {
      for (const col of traversals.cols) {
        const tile = this.grid[row][col];
        if (!tile) continue;

        const { farthest, next } = this.findFarthestPosition({ row, col }, vector);
        const target = next ? this.grid[next.row][next.col] : null;

        // A tile that already absorbed another one this move cannot merge again.
        if (target && target.value === tile.value && !target.mergedFrom) {
          const merged = this.createTile(next.row, next.col, tile.value * 2);
          merged.mergedFrom = [tile.id, target.id];
          merged.previous = null;

          this.grid[tile.row][tile.col] = null;
          this.grid[next.row][next.col] = merged;

          // Both sources animate into the merge cell, then disappear.
          result.removed.push({ ...tile, row: next.row, col: next.col });
          result.removed.push({ ...target });

          this.score += merged.value;
          result.scoreGained += merged.value;
          result.moved = true;

          if (merged.value >= this.winningValue && !this.won) {
            this.won = true;
            result.justWon = true;
          }
        } else if (farthest.row !== tile.row || farthest.col !== tile.col) {
          this.grid[tile.row][tile.col] = null;
          tile.row = farthest.row;
          tile.col = farthest.col;
          this.grid[tile.row][tile.col] = tile;
          result.moved = true;
        }
      }
    }

    if (result.moved) {
      this.moves += 1;
      result.spawned = this.spawnTile();
      if (!this.movesAvailable()) {
        this.over = true;
      }
    }

    result.over = this.over;
    return result;
  }

  /** True when at least one direction would change the board. */
  movesAvailable() {
    if (this.availableCells().length > 0) return true;
    // Board is full: a move is only possible if two neighbours match.
    for (let row = 0; row < this.size; row += 1) {
      for (let col = 0; col < this.size; col += 1) {
        const value = this.grid[row][col].value;
        if (col + 1 < this.size && this.grid[row][col + 1].value === value) return true;
        if (row + 1 < this.size && this.grid[row + 1][col].value === value) return true;
      }
    }
    return false;
  }

  /** True when the board is stuck and the run is finished. */
  isGameOver() {
    return !this.movesAvailable();
  }

  /** Dismiss the win overlay and keep playing past the winning tile. */
  continuePlaying() {
    this.keepPlaying = true;
    return this;
  }

  /** Snapshot suitable for `JSON.stringify`, restored with `Game.fromJSON`. */
  toJSON() {
    return {
      version: 1,
      size: this.size,
      score: this.score,
      moves: this.moves,
      won: this.won,
      keepPlaying: this.keepPlaying,
      over: this.over,
      nextId: this.nextId,
      tiles: this.tiles.map(({ id, value, row, col }) => ({ id, value, row, col })),
    };
  }

  /**
   * Rebuild a game from `toJSON` output.
   * @throws {TypeError} when the snapshot is malformed.
   */
  static fromJSON(data, options = {}) {
    if (!data || typeof data !== 'object') {
      throw new TypeError('snapshot must be an object');
    }
    const size = data.size;
    if (!Number.isInteger(size) || size < 2) {
      throw new TypeError('snapshot has an invalid size');
    }
    if (!Array.isArray(data.tiles)) {
      throw new TypeError('snapshot has no tiles');
    }

    const game = new Game({ ...options, size, startTiles: 0 });
    let maxId = 0;
    for (const raw of data.tiles) {
      const { id, value, row, col } = raw ?? {};
      if (
        !Number.isInteger(row) || row < 0 || row >= size ||
        !Number.isInteger(col) || col < 0 || col >= size ||
        !Number.isInteger(value) || value < 2 || (value & (value - 1)) !== 0
      ) {
        throw new TypeError('snapshot contains an invalid tile');
      }
      if (game.grid[row][col]) {
        throw new TypeError('snapshot stacks two tiles on one cell');
      }
      const tileId = Number.isInteger(id) ? id : ++maxId;
      maxId = Math.max(maxId, tileId);
      game.grid[row][col] = { id: tileId, value, row, col, previous: null, mergedFrom: null, isNew: false };
    }

    game.score = Number.isFinite(data.score) && data.score >= 0 ? data.score : 0;
    game.moves = Number.isInteger(data.moves) && data.moves >= 0 ? data.moves : 0;
    game.won = Boolean(data.won);
    game.keepPlaying = Boolean(data.keepPlaying);
    game.nextId = Number.isInteger(data.nextId) && data.nextId > maxId ? data.nextId : maxId + 1;
    game.over = !game.movesAvailable();
    return game;
  }

  /** @private */
  createTile(row, col, value) {
    return {
      id: this.nextId++,
      value,
      row,
      col,
      previous: null,
      mergedFrom: null,
      isNew: false,
    };
  }

  /** @private Walk from `cell` along `vector` until blocked or off the board. */
  findFarthestPosition(cell, vector) {
    let previous = cell;
    let current = { row: cell.row + vector.row, col: cell.col + vector.col };
    while (this.withinBounds(current) && !this.grid[current.row][current.col]) {
      previous = current;
      current = { row: current.row + vector.row, col: current.col + vector.col };
    }
    return { farthest: previous, next: this.withinBounds(current) ? current : null };
  }

  /** @private */
  withinBounds({ row, col }) {
    return row >= 0 && row < this.size && col >= 0 && col < this.size;
  }
}

/**
 * Traverse the far edge first so tiles pile up against the wall they move
 * toward, rather than leapfrogging each other.
 */
function buildTraversals(vector, size) {
  const rows = [];
  const cols = [];
  for (let i = 0; i < size; i += 1) {
    rows.push(i);
    cols.push(i);
  }
  if (vector.row === 1) rows.reverse();
  if (vector.col === 1) cols.reverse();
  return { rows, cols };
}

/**
 * Deterministic pseudo-random generator (mulberry32), used by tests and by the
 * "seeded run" query parameter so a board can be replayed exactly.
 */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
