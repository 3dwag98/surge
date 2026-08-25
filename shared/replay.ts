/**
 * Run recording and replay.
 *
 * A Surge run is fully determined by its seed and the sequence of timed
 * actions the player took, because the engine draws all randomness from a
 * seeded RNG and reads time only from its arguments. So the client does not
 * report a score — it reports what it *did*, and the server replays the run to
 * work out the score itself.
 *
 * That does not make cheating impossible (a bot can still play well, and a
 * determined forger can synthesise a plausible log), but it does mean a score
 * can only be claimed by producing a legal sequence of moves that actually
 * produces it. No amount of editing a number in a POST body will do.
 */

import { SurgeGame, MAX_MOVES, MAX_RUN_MS } from '../src/game/engine.js';
import type { Direction } from '../src/game/types.js';

/**
 * Single-character action codes, kept short because logs get long.
 *
 * They are uppercase on purpose: the delta that follows is lowercase base-36,
 * so `U`, `R`, `D`, `L` and `V` can never be mistaken for digits and the log
 * stays unambiguous without separators.
 */
const CODE_TO_DIRECTION: Record<string, Direction> = {
  U: 'up',
  R: 'right',
  D: 'down',
  L: 'left',
};

const DIRECTION_TO_CODE: Record<Direction, string> = {
  up: 'U',
  right: 'R',
  down: 'D',
  left: 'L',
};

/** 'V' is a vent; the rest are slides. */
export const VENT_CODE = 'V';

export interface Action {
  /** 'up' | 'right' | 'down' | 'left' | 'vent' */
  type: Direction | 'vent';
  /** Milliseconds since the run started. Non-decreasing. */
  at: number;
}

export interface ReplayOutcome {
  ok: boolean;
  reason?: string;
  score: number;
  merges: number;
  moves: number;
  level: number;
  bestTile: number;
  durationMs: number;
  /** True when the replayed run actually reached its end state. */
  finished: boolean;
}

/**
 * Encode actions as a compact string: an uppercase action code followed by the
 * lowercase base-36 delta in milliseconds since the previous action, e.g.
 * `U0R7iVm3`. A ten-minute run of a few thousand moves stays comfortably
 * inside a small POST body.
 */
export function encodeActions(actions: readonly Action[]): string {
  let previous = 0;
  let out = '';
  for (const action of actions) {
    const code = action.type === 'vent' ? VENT_CODE : DIRECTION_TO_CODE[action.type];
    if (!code) throw new TypeError(`unknown action "${action.type}"`);
    const delta = Math.max(0, Math.round(action.at - previous));
    previous = previous + delta;
    out += code + delta.toString(36);
  }
  return out;
}

/** Parse an encoded log. Returns null when it is malformed. */
export function decodeActions(encoded: string): Action[] | null {
  if (typeof encoded !== 'string') return null;
  if (encoded.length === 0) return [];

  const actions: Action[] = [];
  let at = 0;
  let index = 0;

  while (index < encoded.length) {
    const code = encoded[index]!;
    const type = code === VENT_CODE ? ('vent' as const) : CODE_TO_DIRECTION[code];
    if (!type) return null;

    index += 1;
    let digits = '';
    while (index < encoded.length && /[0-9a-z]/.test(encoded[index]!)) {
      digits += encoded[index]!;
      index += 1;
    }
    if (digits.length === 0) return null;

    const delta = Number.parseInt(digits, 36);
    if (!Number.isFinite(delta) || delta < 0) return null;

    at += delta;
    if (at > MAX_RUN_MS) return null;
    actions.push({ type, at });

    if (actions.length > MAX_MOVES) return null;
  }

  return actions;
}

/**
 * Replay a run and return the score the engine actually produces.
 *
 * @param seed The seed the server issued for this run.
 * @param actions The player's timed actions.
 * @param endedAt Milliseconds from start to the end of the run.
 */
export function replayRun(seed: number, actions: readonly Action[], endedAt: number): ReplayOutcome {
  const failure = (reason: string): ReplayOutcome => ({
    ok: false,
    reason,
    score: 0,
    merges: 0,
    moves: 0,
    level: 0,
    bestTile: 0,
    durationMs: 0,
    finished: false,
  });

  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return failure('bad seed');
  if (!Array.isArray(actions)) return failure('actions must be a list');
  if (actions.length > MAX_MOVES) return failure('too many actions');
  if (!Number.isFinite(endedAt) || endedAt < 0 || endedAt > MAX_RUN_MS) return failure('bad duration');

  let previousAt = 0;
  for (const action of actions) {
    if (!Number.isFinite(action.at) || action.at < previousAt) return failure('actions out of order');
    if (action.at > endedAt) return failure('action after the run ended');
    previousAt = action.at;
  }

  const game = new SurgeGame({ seed });
  game.start(0);

  for (const action of actions) {
    if (game.status !== 'playing') break;
    if (action.type === 'vent') game.vent(action.at);
    else game.move(action.type, action.at);
  }
  game.tick(endedAt);

  const state = game.snapshot(endedAt);
  return {
    ok: true,
    score: state.score,
    merges: state.merges,
    moves: state.moves,
    level: state.level,
    bestTile: state.bestTile,
    durationMs: endedAt,
    finished: state.status === 'over',
  };
}

/** Convenience: replay straight from an encoded log. */
export function replayEncoded(seed: number, encoded: string, endedAt: number): ReplayOutcome {
  const actions = decodeActions(encoded);
  if (!actions) {
    return {
      ok: false,
      reason: 'malformed action log',
      score: 0,
      merges: 0,
      moves: 0,
      level: 0,
      bestTile: 0,
      durationMs: 0,
      finished: false,
    };
  }
  return replayRun(seed, actions, endedAt);
}
