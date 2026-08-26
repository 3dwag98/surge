/** Shared types for the Surge engine. */

export type Direction = 'up' | 'right' | 'down' | 'left';

export const DIRECTIONS: readonly Direction[] = ['up', 'right', 'down', 'left'];

/** Why a tile appeared, so the renderer can pick the right entrance. */
export type TileOrigin = 'start' | 'merge' | 'rise' | 'spawn';

export interface Tile {
  id: number;
  value: number;
  row: number;
  col: number;
  /** Where it sat before the current move, for slide animation. */
  previous: { row: number; col: number } | null;
  /** Ids of the two tiles that produced it, if it came from a merge. */
  mergedFrom: [number, number] | null;
  origin: TileOrigin | null;
}

/** A tile that left the board, positioned where it should animate to. */
export interface Ghost {
  id: number;
  value: number;
  row: number;
  col: number;
  previous: { row: number; col: number } | null;
  /** 'merge' tiles slide into their merge cell; 'vent' and 'crush' burst. */
  reason: 'merge' | 'vent' | 'crush';
}

export interface MoveResult {
  moved: boolean;
  /** Number of merges this move produced. */
  merges: number;
  scoreGained: number;
  /** Combo multiplier the merges were scored at. */
  comboApplied: number;
  removed: Ghost[];
  /** The tile fed in as a reward for moving, if there was room. */
  spawned: Tile | null;
  leveledUp: boolean;
  over: boolean;
}

export interface RiseEvent {
  /** Tiles pushed in along the bottom. */
  spawned: Tile[];
  /** True when the rise pushed a tile off the top and ended the run. */
  crushed: boolean;
  removed: Ghost[];
}

export interface TickResult {
  rises: RiseEvent[];
  comboExpired: boolean;
  over: boolean;
}

export interface VentResult {
  vented: boolean;
  removed: Ghost[];
  /** How many rows were blown out: 1 for a vent, 2 for a Surge, 0 if it did not fire. */
  rows: number;
}

/** Serialisable snapshot — this is what the agent API hands out. */
export interface GameState {
  status: 'idle' | 'playing' | 'over';
  cols: number;
  rows: number;
  /** Row-major values, 0 for an empty cell. Row 0 is the top. */
  grid: number[][];
  tiles: Tile[];
  score: number;
  combo: number;
  /** Fraction of the combo window still left, 1 → 0. */
  comboRemaining: number;
  charge: number;
  chargeMax: number;
  /** Charge at which the vent overcharges into a two-row Surge. */
  chargeSurge: number;
  /** True when charge is full and vent() will fire. */
  canVent: boolean;
  /** True when the meter has overcharged and the next vent clears two rows. */
  canSurge: boolean;
  /** The valve re-arms on each rise: at most one vent per rise cycle. */
  ventArmed: boolean;
  level: number;
  merges: number;
  moves: number;
  /** Fraction of the way to the next rise, 0 → 1. */
  risePressure: number;
  msToRise: number;
  elapsedMs: number;
  bestTile: number;
  seed: number;
}
