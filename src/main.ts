/**
 * Entry point: owns the run, the frame loop and the wiring between the engine,
 * the renderer, the tutorial, the agent API and the server.
 *
 * The engine is the only thing that knows the rules. Everything here is
 * presentation, input, and shipping the result somewhere.
 */

import './styles.css';

import { CHARGE_MAX, SurgeGame } from './game/engine.js';
import { randomSeed } from './game/rng.js';
import type { Direction, GameState } from './game/types.js';
import { Renderer } from './render/renderer.js';
import { api } from './net/api.js';
import { installAgentApi, type InstalledAgentApi } from './ui/agent.js';
import { LeaderboardView, formatNumber } from './ui/leaderboard.js';
import { Podium } from './ui/podium.js';
import { ThemeController } from './ui/theme.js';
import { Tutorial } from './ui/tutorial.js';
import { encodeActions, type Action } from '../shared/replay.js';
import { sanitizeName } from '../shared/rules.js';

const NAME_KEY = 'surge.name';
const TUTORIAL_KEY = 'surge.tutorial.seen';

const KEY_DIRECTIONS: Record<string, Direction> = {
  arrowup: 'up',
  arrowright: 'right',
  arrowdown: 'down',
  arrowleft: 'left',
  w: 'up',
  d: 'right',
  s: 'down',
  a: 'left',
  k: 'up',
  l: 'right',
  j: 'down',
  h: 'left',
};

const SWIPE_THRESHOLD = 26;

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
};

/* --------------------------------------------------------------- elements */

const canvas = $<HTMLCanvasElement>('#board');
const els = {
  score: $('#score'),
  best: $('#best'),
  combo: $('#combo'),
  level: $('#level'),
  vent: $<HTMLButtonElement>('#vent'),
  newGame: $<HTMLButtonElement>('#new-game'),
  howTo: $<HTMLButtonElement>('#how-to'),
  status: $('#board-status'),

  overlay: $('#overlay'),
  overlayTitle: $('#overlay-title'),
  overlayStats: $('#overlay-stats'),
  saveForm: $<HTMLFormElement>('#save-form'),
  playerName: $<HTMLInputElement>('#player-name'),
  scoresCount: $('#scores-count'),
  saveButton: $<HTMLButtonElement>('#save-score'),
  saveStatus: $('#save-status'),
  playAgain: $<HTMLButtonElement>('#play-again'),
};

const leaderboard = new LeaderboardView({
  body: $('#leaderboard-body'),
  empty: $('#leaderboard-empty'),
  table: $('#leaderboard-table'),
  status: $('#leaderboard-status'),
});

const podium = new Podium($('#podium'));

new ThemeController({
  toggle: $<HTMLButtonElement>('#theme-toggle'),
  meta: document.querySelector<HTMLMetaElement>('#theme-color'),
});

const tutorial = new Tutorial({
  root: $('#tutorial'),
  titleEl: $('#tutorial-title'),
  bodyEl: $('#tutorial-body'),
  keysEl: $('#tutorial-keys'),
  progressEl: $('#tutorial-progress'),
  nextButton: $<HTMLButtonElement>('#tutorial-next'),
  skipButton: $<HTMLButtonElement>('#tutorial-skip'),
  onFinish: () => {
    safeSet(TUTORIAL_KEY, '1');
    startRun();
  },
});

/* ------------------------------------------------------------------ state */

const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let game = new SurgeGame({ seed: randomSeed() });
let renderer = new Renderer(canvas, { cols: game.cols, rows: game.rows, reducedMotion });

/** Wall-clock origin for the current run; engine time is relative to it. */
let runOrigin = 0;
let actions: Action[] = [];
let runId: string | null = null;
let submitted = false;
/** Engine time at which the run ended — not when the player got round to posting it. */
let runEndedAt = 0;
let best = Number(safeGet('surge.best') ?? 0) || 0;
let agent: InstalledAgentApi;

/**
 * Time the run has actually been watchable, in milliseconds.
 *
 * requestAnimationFrame is frozen while the tab is hidden, so the engine stops
 * ticking — but wall-clock time does not. Without this the rises that fell due
 * while you were away all land in the first frame after you come back and bury
 * you before you can move. Discounting hidden time pauses the run instead.
 *
 * Every other timestamp is derived from this, including the offsets in the
 * action log, so the server's replay stays in step with what the player saw.
 */
let hiddenTotal = 0;
let hiddenSince = 0;

const hiddenElapsed = (): number => (hiddenSince ? performance.now() - hiddenSince : 0);

const engineNow = (): number => performance.now() - runOrigin - hiddenTotal - hiddenElapsed();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenSince = performance.now();
  } else if (hiddenSince) {
    hiddenTotal += performance.now() - hiddenSince;
    hiddenSince = 0;
  }
});

/* ------------------------------------------------------------- run control */

async function startRun(): Promise<void> {
  submitted = false;
  actions = [];
  runId = null;

  // Ask the server for a seed so it can replay and verify the run later. If it
  // is unreachable the game still plays, it just cannot post a score.
  let seed = randomSeed();
  try {
    const ticket = await api.startRun();
    seed = ticket.seed;
    runId = ticket.runId;
  } catch {
    runId = null;
  }

  game = new SurgeGame({ seed });
  runOrigin = performance.now();
  hiddenTotal = 0;
  hiddenSince = document.hidden ? performance.now() : 0;
  game.start(0);

  renderer.clear();
  renderer.sync(game.tiles);
  hideOverlay();
  updateHud(game.snapshot(0));
  announce('New run started.');
  publish();
}

function record(type: Action['type'], at: number): void {
  actions.push({ type, at: Math.round(at) });
}

/* ------------------------------------------------------------------ input */

function applyMove(direction: Direction): void {
  if (game.status !== 'playing' || !els.overlay.hidden) return;

  const at = engineNow();
  const result = game.move(direction, at);
  if (!result.moved) {
    // A rejected move changes nothing, so it stays out of the log and the
    // replay matches byte for byte. The move still ticks time, though, which
    // can be what ends the run.
    if (result.over) finishRun();
    return;
  }

  record(direction, at);
  renderer.applyGhosts(result.removed);
  renderer.sync(game.tiles);

  if (result.merges > 0) {
    for (const tile of game.tiles) {
      if (tile.mergedFrom) {
        renderer.onMerge(tile.row, tile.col, tile.value, result.comboApplied, result.scoreGained);
        break;
      }
    }
  }
  if (result.leveledUp) announce(`Level ${game.level}. The floor is rising faster.`);

  afterStateChange(at);
}

function applyVent(): void {
  if (!game.canVent || !els.overlay.hidden) return;
  const at = engineNow();
  const result = game.vent(at);
  if (!result.vented) return;

  record('vent', at);
  renderer.applyGhosts(result.removed);
  renderer.sync(game.tiles);
  renderer.onVent();
  announce('Vented. The board dropped and the timer reset.');
  afterStateChange(at);
}

function afterStateChange(at: number): void {
  const state = game.snapshot(at);
  updateHud(state);
  agent.publish(state);
  if (state.status === 'over') finishRun();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (isTypingTarget(event.target)) return;

  if (event.key === ' ' || event.code === 'Space') {
    event.preventDefault();
    applyVent();
    return;
  }
  const direction = KEY_DIRECTIONS[event.key.toLowerCase()];
  if (!direction) return;
  event.preventDefault();
  applyMove(direction);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/* ------------------------------------------------------------------- HUD */

function updateHud(state: GameState): void {
  els.score.textContent = formatNumber(state.score);
  if (state.score > best) {
    best = state.score;
    safeSet('surge.best', String(best));
  }
  els.best.textContent = formatNumber(best);

  els.combo.textContent = `${state.combo}x`;
  els.combo.classList.toggle('is-hot', state.combo >= 4);
  els.combo.style.setProperty('--combo-fill', String(state.comboRemaining));

  els.level.textContent = String(state.level);

  els.vent.disabled = !state.canVent;
  els.vent.classList.toggle('is-ready', state.canVent);
  els.vent.style.setProperty('--charge', String(Math.min(1, state.charge / CHARGE_MAX)));
}

function announce(message: string): void {
  els.status.textContent = message;
}

/* --------------------------------------------------------------- game over */

function finishRun(): void {
  if (!els.overlay.hidden) return;
  runEndedAt = engineNow();
  const state = game.snapshot(runEndedAt);

  els.overlayTitle.textContent = 'Buried';
  els.overlayStats.textContent =
    `${formatNumber(state.score)} points · level ${state.level} · ` +
    `${formatNumber(state.merges)} merges · best tile ${formatNumber(state.bestTile)}`;

  const canSave = state.score > 0 && runId !== null && !submitted;
  els.saveForm.hidden = !canSave;
  els.saveStatus.textContent = runId === null && state.score > 0 ? 'Offline — this run cannot be posted.' : '';
  els.saveStatus.classList.remove('is-error');
  els.overlay.hidden = false;
  if (canSave) els.playerName.focus();
  else els.playAgain.focus();

  announce(`Run over. ${state.score} points.`);
  agent.publish(state);
}

function hideOverlay(): void {
  els.overlay.hidden = true;
}

async function submitScore(event: Event): Promise<void> {
  event.preventDefault();
  if (submitted || !runId) return;

  const name = sanitizeName(els.playerName.value);
  els.saveButton.disabled = true;
  els.saveStatus.classList.remove('is-error');
  els.saveStatus.textContent = 'Verifying run…';

  try {
    const outcome = await api.finishRun(runId, {
      name,
      log: encodeActions(actions),
      durationMs: Math.round(runEndedAt),
    });

    submitted = true;
    safeSet(NAME_KEY, name);
    leaderboard.setRows(outcome.scores);
    leaderboard.highlight(outcome.entry.id);
    // A posted run can change the podium, so refresh it here rather than
    // making the player reload to see it.
    podium.setRows(outcome.podium);
    els.scoresCount.textContent = String(outcome.scores.length);
    els.saveForm.hidden = true;
    els.overlayStats.textContent = outcome.wonPodium
      ? `${formatNumber(outcome.verifiedScore)} points — #${outcome.rank}, and you are on the podium.`
      : outcome.rank
        ? `${formatNumber(outcome.verifiedScore)} points — #${outcome.rank} on the board.`
        : `${formatNumber(outcome.verifiedScore)} points. Not a top ${leaderboard.entries.length} run this time.`;
    els.playAgain.focus();
  } catch (error) {
    els.saveStatus.classList.add('is-error');
    els.saveStatus.textContent =
      error instanceof Error ? `Could not post: ${error.message}` : 'Could not post this run.';
  } finally {
    els.saveButton.disabled = false;
  }
}

/* -------------------------------------------------------------- frame loop */

function frame(): void {
  const at = engineNow();
  const tick = game.tick(at);

  for (const rise of tick.rises) {
    renderer.applyGhosts(rise.removed);
    renderer.onRise(rise.crushed);
  }
  if (tick.rises.length > 0) {
    renderer.sync(game.tiles);
    const state = game.snapshot(at);
    updateHud(state);
    agent.publish(state);
  }
  if (tick.over && els.overlay.hidden) finishRun();

  const state = game.snapshot(at);
  // Feed the tutorial every frame: its action-gated steps compare against the
  // previous state, so it needs a fresh baseline rather than one captured
  // whenever a move happened to occur.
  tutorial.update(state);
  renderer.draw(performance.now(), {
    risePressure: state.risePressure,
    combo: state.combo,
    comboRemaining: state.comboRemaining,
    charge: state.charge,
    over: state.status === 'over',
  });
  // The combo ring drains continuously, so refresh it every frame.
  els.combo.style.setProperty('--combo-fill', String(state.comboRemaining));

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------- boot */

/** Directions that would actually change the board, for the agent API. */
function legalMoves(): Direction[] {
  if (game.status !== 'playing') return [];
  const grid = game.snapshot().grid;

  return (['up', 'right', 'down', 'left'] as Direction[]).filter((direction) => {
    // Probe on a throwaway copy so asking never disturbs the real run.
    const probe = new SurgeGame({ seed: game.seed, startTiles: 0 });
    probe.start(0);
    restoreInto(probe, grid);
    return probe.move(direction, 1).moved;
  });
}

/** Copy a plain value grid into a scratch game, for move probing. */
function restoreInto(target: SurgeGame, grid: number[][]): void {
  const internals = target as unknown as {
    grid: unknown[][];
    createTile(row: number, col: number, value: number): unknown;
  };
  for (let row = 0; row < grid.length; row += 1) {
    for (let col = 0; col < grid[row]!.length; col += 1) {
      const value = grid[row]![col]!;
      internals.grid[row]![col] = value ? internals.createTile(row, col, value) : null;
    }
  }
}

function publish(): void {
  agent.publish(game.snapshot(engineNow()));
}

function bindEvents(): void {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => renderer.resize());

  els.newGame.addEventListener('click', () => void startRun());
  els.playAgain.addEventListener('click', () => void startRun());
  els.vent.addEventListener('click', () => applyVent());
  els.howTo.addEventListener('click', () => tutorial.start());
  els.saveForm.addEventListener('submit', (event) => void submitScore(event));

  let touchStart: { x: number; y: number } | null = null;
  canvas.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      touchStart = { x: touch.clientX, y: touch.clientY };
    },
    { passive: true },
  );
  canvas.addEventListener('touchend', (event) => {
    if (!touchStart) return;
    const touch = event.changedTouches[0]!;
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    touchStart = null;

    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return;
    event.preventDefault();
    applyMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  });
  canvas.addEventListener('touchcancel', () => {
    touchStart = null;
  });
}

async function boot(): Promise<void> {
  agent = installAgentApi({
    getState: () => game.snapshot(engineNow()),
    move: (direction) => applyMove(direction),
    vent: () => applyVent(),
    newGame: () => void startRun(),
    legalMoves,
  });

  bindEvents();
  els.playerName.value = safeGet(NAME_KEY) ?? '';
  els.best.textContent = formatNumber(best);

  void leaderboard.refresh().then((rows) => {
    podium.setRows(rows);
    els.scoresCount.textContent = String(leaderboard.entries.length);
  });

  await startRun();

  // First-time visitors get taught the game rather than dropped into it.
  if (!safeGet(TUTORIAL_KEY)) tutorial.start();

  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- storage */

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled; nothing to do */
  }
}

void boot();
