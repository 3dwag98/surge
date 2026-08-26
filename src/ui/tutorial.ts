/**
 * The human half of the tutorial.
 *
 * Every mechanic here is something that moves, so each step leads with a small
 * looping picture of it and keeps the words short — a diagram of a row shoving
 * the board upward teaches the rising floor faster than a paragraph can. Steps
 * that are actions refuse to advance until you actually do the thing, watching
 * live game state to decide.
 */

import type { GameState } from '../game/types.js';
import { buildDiagram, type DiagramName } from './diagrams.js';

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** The mechanic to show. Steps with nothing to show simply have none. */
  diagram?: DiagramName;
  /** Optional hint chip, e.g. the keys to press. */
  keys?: string[];
  /** Completes the step. Omit for a read-and-continue step. */
  done?: (state: GameState, previous: GameState | null) => boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'The floor is rising',
    diagram: 'rise',
    body:
      'Every few seconds a new row shoves in from below and the whole board moves up. Anything still in the top row when that happens is crushed, and the run is over. That is the clock you are playing against.',
  },
  {
    id: 'slide',
    title: 'Slide the board',
    diagram: 'slide',
    body:
      'Arrow keys, WASD, or swipe. Every tile shifts as far as it can go in that direction. Try any direction now.',
    keys: ['←', '↑', '→', '↓'],
    done: (state, previous) => previous !== null && state.moves > previous.moves,
  },
  {
    id: 'merge',
    title: 'Merge two tiles',
    diagram: 'merge',
    body:
      'Slide two tiles of the same number together and they fuse into their sum. A tile can only merge once per move, so 2 2 2 2 becomes 4 4, never 8.',
    done: (state, previous) => previous !== null && state.merges > previous.merges,
  },
  {
    id: 'combo',
    title: 'Chain merges for the multiplier',
    diagram: 'combo',
    body:
      'Each merge opens a short window. Merge again before it closes and the multiplier climbs, up to 9x — so a fast chain of small merges beats one slow big one. Get your combo to 3.',
    done: (state) => state.combo >= 3,
  },
  {
    id: 'rise',
    title: 'Watch the ceiling',
    diagram: 'rise',
    body:
      'The bar along the top of the board is the rise timer. When it fills, the floor comes up — and it fills faster every level. Keep the top row clear. Sliding up is how you die.',
    keys: ['⏱'],
  },
  {
    id: 'vent',
    title: 'Vent to buy room',
    diagram: 'vent',
    body:
      'Merging charges the meter along the bottom. Full, press Space: the bottom row blows out and the board drops. It buys space, not time — the timer keeps running, and the valve re-arms only on the next rise.',
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
  diagramEl: HTMLElement;
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

    // Rebuilt rather than hidden, so every step restarts its loop from frame
    // one instead of joining an animation already in progress.
    this.host.diagramEl.replaceChildren(...(step.diagram ? [buildDiagram(step.diagram)] : []));
    this.host.diagramEl.hidden = !step.diagram;

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
