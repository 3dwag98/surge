/**
 * Attract mode.
 *
 * An arcade cabinet does not sit on a title card — it plays itself until
 * somebody puts a coin in. Surge does the same, and it is the honest thing for
 * this game to do: `window.surge` exists precisely so bots can play, so the
 * page demonstrating itself with a bot is the product, not a mock-up.
 *
 * The demo runs on the real engine and the real renderer, but never on a server
 * ticket: a visitor who only watches costs no run and posts no score. The first
 * key, click or touch hands the board over.
 *
 * Under `prefers-reduced-motion` there is no demo at all — the caller holds the
 * board still and shows the same prompt.
 */

import type { Direction } from '../game/types.js';

/** How long the demo waits between moves. Slow enough to read, fast enough to combo. */
const MOVE_INTERVAL_MS = 260;
/** Pause on the wreckage before the demo starts over. */
const RESTART_DELAY_MS = 1500;

export interface AttractHooks {
  /** Directions that would actually change the board. */
  legalMoves(): Direction[];
  /** Play one move. The caller decides that a demo move is not logged. */
  move(direction: Direction): void;
  /** Is the demo run still alive? */
  isPlaying(): boolean;
  /** Throw the wreck away and deal a fresh demo board. */
  restart(): void;
}

/**
 * The demo's taste in moves.
 *
 * It prefers down and sideways because those pack the floor, and takes `up`
 * only when nothing else is legal — sliding up is how you die, so a demo that
 * did it freely would bury itself in seconds and never show a combo.
 */
const PREFERENCE: Direction[] = ['down', 'left', 'right', 'up'];

export class AttractMode {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private hooks: AttractHooks) {}

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(MOVE_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.step(), delay);
  }

  private step(): void {
    if (!this.running) return;

    if (!this.hooks.isPlaying()) {
      this.hooks.restart();
      this.schedule(MOVE_INTERVAL_MS);
      return;
    }

    const legal = this.hooks.legalMoves();
    if (legal.length === 0) {
      // Nothing to do but wait for the floor to hand us a move.
      this.schedule(MOVE_INTERVAL_MS);
      return;
    }

    const pick = PREFERENCE.find((direction) => legal.includes(direction)) ?? legal[0]!;
    this.hooks.move(pick);
    this.schedule(this.hooks.isPlaying() ? MOVE_INTERVAL_MS : RESTART_DELAY_MS);
  }
}
