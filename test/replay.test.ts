import { describe, expect, it } from 'vitest';

import { SurgeGame, MAX_MOVES, MAX_RUN_MS } from '../src/game/engine.js';
import {
  decodeActions,
  encodeActions,
  replayEncoded,
  replayRun,
  type Action,
} from '../shared/replay.js';

const script: Action[] = [
  { type: 'left', at: 0 },
  { type: 'down', at: 420 },
  { type: 'right', at: 900 },
  { type: 'vent', at: 1500 },
  { type: 'up', at: 2400 },
  { type: 'left', at: 12_000 },
];

describe('action log encoding', () => {
  it('round-trips', () => {
    expect(decodeActions(encodeActions(script))).toEqual(script);
  });

  it('encodes compactly', () => {
    const encoded = encodeActions(script);
    expect(encoded.length).toBeLessThan(script.length * 6);
    expect(encoded).toMatch(/^[URDLV0-9a-z]+$/);
  });

  it('stays unambiguous when a delta looks like an action code', () => {
    // Deltas are lowercase base-36; codes are uppercase. 'd' as a digit is 13.
    const actions: Action[] = [
      { type: 'down', at: 13 },
      { type: 'left', at: 26 },
      { type: 'up', at: 57 },
    ];
    expect(decodeActions(encodeActions(actions))).toEqual(actions);
  });

  it('handles an empty log', () => {
    expect(encodeActions([])).toBe('');
    expect(decodeActions('')).toEqual([]);
  });

  it('rejects malformed logs', () => {
    expect(decodeActions('X5')).toBeNull(); // unknown code
    expect(decodeActions('U')).toBeNull(); // code with no delta
    expect(decodeActions('5U')).toBeNull(); // starts with a digit
    expect(decodeActions(null as unknown as string)).toBeNull();
  });

  it('rejects a log that runs past the maximum run length', () => {
    const tooLate = `U${(MAX_RUN_MS + 1000).toString(36)}`;
    expect(decodeActions(tooLate)).toBeNull();
  });
});

describe('replay', () => {
  it('derives the same score the live game produced', () => {
    const seed = 4242;

    // Play it "live".
    const live = new SurgeGame({ seed });
    live.start(0);
    for (const action of script) {
      if (action.type === 'vent') live.vent(action.at);
      else live.move(action.type, action.at);
    }
    live.tick(14_000);
    const expected = live.snapshot(14_000);

    const outcome = replayRun(seed, script, 14_000);

    expect(outcome.ok).toBe(true);
    expect(outcome.score).toBe(expected.score);
    expect(outcome.merges).toBe(expected.merges);
    expect(outcome.bestTile).toBe(expected.bestTile);
    expect(outcome.level).toBe(expected.level);
  });

  it('gives the same answer through the encoded form', () => {
    const direct = replayRun(1337, script, 14_000);
    const encoded = replayEncoded(1337, encodeActions(script), 14_000);
    expect(encoded).toEqual(direct);
  });

  it('a different seed produces a different run', () => {
    const a = replayRun(1, script, 14_000);
    const b = replayRun(2, script, 14_000);
    expect(a.ok && b.ok).toBe(true);
    // Same inputs, different board: the scores should not silently match.
    expect(a).not.toEqual(b);
  });

  it('is stable across repeated replays', () => {
    expect(replayRun(99, script, 14_000)).toEqual(replayRun(99, script, 14_000));
  });

  it('cannot be talked into a score by claiming one', () => {
    // There is no score input at all — the only way the number moves is by
    // supplying actions that actually earn it.
    const honest = replayRun(7, script, 14_000);
    const empty = replayRun(7, [], 14_000);
    expect(empty.score).toBe(0);
    expect(honest.score).toBeGreaterThanOrEqual(0);
  });

  it('rejects out-of-order actions', () => {
    const outcome = replayRun(1, [
      { type: 'left', at: 500 },
      { type: 'right', at: 200 },
    ], 1000);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/order/);
  });

  it('rejects actions after the run ended', () => {
    const outcome = replayRun(1, [{ type: 'left', at: 5000 }], 1000);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/after/);
  });

  it('rejects an absurd number of actions', () => {
    const many: Action[] = Array.from({ length: MAX_MOVES + 1 }, (_, i) => ({
      type: 'left' as const,
      at: i,
    }));
    expect(replayRun(1, many, MAX_MOVES + 10).ok).toBe(false);
  });

  it('rejects a bad seed or duration', () => {
    expect(replayRun(-1, script, 1000).ok).toBe(false);
    expect(replayRun(1.5, script, 1000).ok).toBe(false);
    expect(replayRun(1, script, -5).ok).toBe(false);
    expect(replayRun(1, script, MAX_RUN_MS + 1).ok).toBe(false);
  });

  it('rejects a malformed encoded log without throwing', () => {
    const outcome = replayEncoded(1, 'not-a-log!!', 1000);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/malformed/);
  });

  it('stops scoring once the run is over', () => {
    // Idle long enough that rises end the run, then keep issuing moves.
    const actions: Action[] = Array.from({ length: 40 }, (_, i) => ({
      type: 'up' as const,
      at: i * 9000,
    }));
    const outcome = replayRun(11, actions, 40 * 9000);

    expect(outcome.ok).toBe(true);
    expect(outcome.finished).toBe(true);
  });
});
