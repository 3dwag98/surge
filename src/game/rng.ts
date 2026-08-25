/**
 * Deterministic RNG.
 *
 * Every source of chance in the engine runs through this, so a run is fully
 * described by its seed plus its move log. That is what lets the server replay
 * a submitted run and derive the score itself instead of trusting the client.
 */

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, max). */
  int(max: number): number;
  /** Pick an element. Returns undefined for an empty array. */
  pick<T>(items: readonly T[]): T | undefined;
  /** How many numbers have been drawn — part of the engine's identity. */
  readonly draws: number;
}

/** mulberry32: small, fast, and stable across JS engines. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  let draws = 0;

  const next = (): number => {
    draws += 1;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },
    get draws() {
      return draws;
    },
  };
}

/**
 * A seed for a fresh run. Uses crypto where available.
 *
 * Typed structurally rather than against `Crypto`, because this module is
 * compiled for both the browser and the Worker and the two lib sets disagree
 * about what lives on `globalThis`.
 */
export function randomSeed(): number {
  const source = (globalThis as { crypto?: { getRandomValues?(array: Uint32Array): Uint32Array } })
    .crypto;
  if (source?.getRandomValues) {
    return source.getRandomValues(new Uint32Array(1))[0]!;
  }
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
