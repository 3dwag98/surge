/**
 * The human half of the tutorial.
 *
 * Rather than a wall of text, this walks through the four things that make
 * Surge different from every other merge game, one at a time, and refuses to
 * advance until you actually do each one. Each step can watch live game state,
 * so "merge two tiles" completes when you merge two tiles.
 */

import type { GameState } from '../game/types.js';

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** Optional hint chip, e.g. the keys to press. */
  keys?: string[];
  /** Completes the step. Omit for a read-and-continue step. */
  done?: (state: GameState, previous: GameState | null) => boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'This is not 2048',
    body:
      'Same idea — slide the board, equal tiles merge and double. Everything else is different: the floor keeps rising, merging fast is worth more than merging big, and there is no winning tile. You play for score until the board buries you.',
  },
  {
    id: 'slide',
    title: 'Slide the board',
    body:
      'Arrow keys, WASD, or swipe. Every tile shifts as far as it can go in that direction. Try any direction now.',
    keys: ['←', '↑', '→', '↓'],
    done: (state, previous) => previous !== null && state.moves > previous.moves,
  },
  {
    id: 'merge',
    title: 'Merge two tiles',
    body:
      'Line up two tiles of the same number and slide them together. They fuse into their sum. A tile can only merge once per move, so 2 2 2 2 becomes 4 4, never 8.',
    done: (state, previous) => previous !== null && state.merges > previous.merges,
  },
  {
    id: 'combo',
    title: 'Chain merges for the multiplier',
    body:
      'Here is the real scoring. Each merge opens a short window — merge again before it closes and your multiplier climbs. Points are the merged value times the multiplier you already had, so a fast chain of small merges beats one slow big one. Get your combo to 3.',
    done: (state) => state.combo >= 3,
  },
  {
    id: 'rise',
    title: 'Watch the floor',
    body:
      'The bar under the board is the rise timer. When it fills, a new row shoves in from the bottom and everything moves up one. It gets faster every level. Anything still in the top row when a row rises gets crushed, and the run is over — so keep the top clear. Sliding up is how you die.',
    keys: ['⏱'],
  },
  {
    id: 'vent',
    title: 'Vent to buy room',
    body:
      'Every merge charges the thin bar above the timer. Fill it and press Space to Vent: the bottom row is blown out and the whole board drops back down. It buys space, not time — the rise timer keeps running, and the valve only re-arms after the next rise. Spend it before you are already dead, not after.',
    keys: ['Space'],
  },
  {
    id: 'go',
    title: 'That is everything',
    body:
      'Merge fast, keep the top row empty, and bank a Vent for when it gets tight. Your score goes on the public board when the run ends. Good luck.',
  },
];

export interface TutorialHost {
  root: HTMLElement;
  titleEl: HTMLElement;
  bodyEl: HTMLElement;
  keysEl: HTMLElement;
  progressEl: HTMLElement;
  nextButton: HTMLButtonElement;
  skipButton: HTMLButtonElement;
  onFinish(): void;
}

export class Tutorial {
  private index = 0;
  private previous: GameState | null = null;
  private active = false;

  constructor(private host: TutorialHost) {
    host.nextButton.addEventListener('click', () => this.advance());
    host.skipButton.addEventListener('click', () => this.finish());
  }

  get isActive(): boolean {
    return this.active;
  }

  get step(): TutorialStep | null {
    return this.active ? TUTORIAL_STEPS[this.index] ?? null : null;
  }

  start(): void {
    this.active = true;
    this.index = 0;
    this.previous = null;
    this.host.root.hidden = false;
    this.render();
  }

  finish(): void {
    if (!this.active) return;
    this.active = false;
    this.host.root.hidden = true;
    this.host.onFinish();
  }

  /** Feed live state so action-gated steps can complete themselves. */
  update(state: GameState): void {
    if (!this.active) return;
    const step = TUTORIAL_STEPS[this.index];
    if (step?.done && step.done(state, this.previous)) {
      this.previous = state;
      this.advance();
      return;
    }
    this.previous = state;
  }

  private advance(): void {
    if (this.index >= TUTORIAL_STEPS.length - 1) {
      this.finish();
      return;
    }
    this.index += 1;
    this.render();
  }

  private render(): void {
    const step = TUTORIAL_STEPS[this.index];
    if (!step) return;

    this.host.titleEl.textContent = step.title;
    this.host.bodyEl.textContent = step.body;

    this.host.keysEl.replaceChildren(
      ...(step.keys ?? []).map((key) => {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        return kbd;
      }),
    );
    this.host.keysEl.hidden = !step.keys?.length;

    this.host.progressEl.replaceChildren(
      ...TUTORIAL_STEPS.map((_, i) => {
        const dot = document.createElement('span');
        dot.className = 'tutorial-dot';
        if (i === this.index) dot.classList.add('is-current');
        if (i < this.index) dot.classList.add('is-done');
        return dot;
      }),
    );

    const isLast = this.index === TUTORIAL_STEPS.length - 1;
    // A step you have to *do* completes itself; don't offer a button that skips it.
    this.host.nextButton.textContent = isLast ? 'Play' : step.done ? 'Skip step' : 'Next';
    this.host.skipButton.hidden = isLast;
  }
}
