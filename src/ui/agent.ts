/**
 * Programmatic play API, exposed as `window.surge`.
 *
 * The brief asked for a tutorial "for any human or agent". This is the agent
 * half: a small, stable, synchronous surface an LLM or a script can drive
 * without scraping the DOM or synthesising key events. It is the same code
 * path the keyboard uses, so anything an agent does here is a real move and
 * lands on the leaderboard through the same verified replay as a human run.
 *
 * The prose half lives in /agent.md, which documents this contract.
 */

import type { Direction, GameState } from '../game/types.js';

export interface SurgeAgentApi {
  readonly version: string;
  /** Full rules and this contract, in Markdown. */
  readonly docs: string;
  /** Current board and run state. Safe to poll. */
  getState(): GameState;
  /** Slide. Returns the state after the move. Throws on a bad direction. */
  move(direction: Direction): GameState;
  /** Convenience wrappers. */
  up(): GameState;
  down(): GameState;
  left(): GameState;
  right(): GameState;
  /** Spend a full charge meter. No-op when `canVent` is false. */
  vent(): GameState;
  /** Abandon the current run and start a fresh one. */
  newGame(): GameState;
  /** Legal directions that would actually change the board right now. */
  legalMoves(): Direction[];
  /** Fires after every state change. Returns an unsubscribe function. */
  subscribe(listener: (state: GameState) => void): () => void;
  /** Resolves when the run ends, with the final state. */
  waitForGameOver(timeoutMs?: number): Promise<GameState>;
}

export interface AgentHooks {
  getState(): GameState;
  move(direction: Direction): void;
  vent(): void;
  newGame(): void;
  legalMoves(): Direction[];
}

const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];

export interface InstalledAgentApi {
  api: SurgeAgentApi;
  /**
   * Broadcast a state change the agent did not cause — a keyboard move, a rise
   * firing, the run ending — so subscribers see one consistent stream.
   */
  publish(state: GameState): void;
}

export function installAgentApi(hooks: AgentHooks, docsUrl = '/agent.md'): InstalledAgentApi {
  const listeners = new Set<(state: GameState) => void>();
  let docs = `Fetch ${docsUrl} for the full rules.`;

  // Load the prose docs so an agent that only has the JS handle can still read
  // the rules without a second fetch of its own.
  void fetch(docsUrl)
    .then((response) => (response.ok ? response.text() : null))
    .then((text) => {
      if (text) docs = text;
    })
    .catch(() => {
      /* docs stay as the pointer */
    });

  const notify = (state: GameState): GameState => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A broken listener must not break the game.
      }
    }
    return state;
  };

  const api: SurgeAgentApi = {
    version: '1.0',
    get docs() {
      return docs;
    },

    getState: () => hooks.getState(),

    move(direction: Direction): GameState {
      if (!DIRECTIONS.includes(direction)) {
        throw new TypeError(`unknown direction "${direction}" — use up, right, down or left`);
      }
      hooks.move(direction);
      return notify(hooks.getState());
    },

    up: () => api.move('up'),
    down: () => api.move('down'),
    left: () => api.move('left'),
    right: () => api.move('right'),

    vent(): GameState {
      hooks.vent();
      return notify(hooks.getState());
    },

    newGame(): GameState {
      hooks.newGame();
      return notify(hooks.getState());
    },

    legalMoves: () => hooks.legalMoves(),

    subscribe(listener: (state: GameState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    waitForGameOver(timeoutMs = 10 * 60 * 1000): Promise<GameState> {
      return new Promise((resolve, reject) => {
        const current = hooks.getState();
        if (current.status === 'over') {
          resolve(current);
          return;
        }
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error('timed out waiting for game over'));
        }, timeoutMs);
        const unsubscribe = api.subscribe((state) => {
          if (state.status === 'over') {
            clearTimeout(timer);
            unsubscribe();
            resolve(state);
          }
        });
      });
    },
  };

  (globalThis as unknown as { surge: SurgeAgentApi }).surge = api;
  return { api, publish: notify };
}
