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
import { api, apiMessage, ApiError } from './net/api.js';
import { installAgentApi, type InstalledAgentApi } from './ui/agent.js';
import { AttractMode } from './ui/attract.js';
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
  ventLabel: $('#vent-label'),
  ventKey: $('#vent-key'),
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
  runNote: $('#run-note'),
  playAgain: $<HTMLButtonElement>('#play-again'),
  attract: $('#attract'),
  attractStart: $<HTMLButtonElement>('#attract-start'),
};

const leaderboard = new LeaderboardView({
  body: $('#leaderboard-body'),
  empty: $('#leaderboard-empty'),
  table: $('#leaderboard-table'),
  status: $('#leaderboard-status'),
});

const podium = new Podium($('#podium'));

const attract = new AttractMode({
  legalMoves: () => legalMoves(),
  move: (direction) => applyMove(direction),
  isPlaying: () => game.status === 'playing',
  restart: () => startDemo(),
});

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
 * Whose board is this?
 *
 *   idle    — held still, waiting to be taken (what reduced motion gets)
 *   attract — the cabinet playing itself; local seed, no ticket, nothing logged
 *   live    — a real run, ticketed and logged
 *
 * Only a live run touches the action log, the personal best or the server.
 */
let mode: 'idle' | 'attract' | 'live' = 'idle';
/** True while a run ticket is in flight, so the board is only claimed once. */
let claiming = false;
/**
 * Why this run cannot be posted, if it cannot. Null when it has a ticket.
 *
 * The run still plays either way — the game does not need the network — but the
 * player is told at the start rather than being handed the bad news after a
 * good run.
 */
let ticketProblem: string | null = null;
/**
 * Wall-clock time before which we will not ask for another run ticket.
 *
 * A client that keeps retrying through a rate limit is part of the storm. When
 * the server says 429 or 503 it also says how long to wait, and until then new
 * runs start locally without touching the network at all.
 */
let ticketCooldownUntil = 0;

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

/**
 * Deal a board nobody owns yet.
 *
 * No server ticket is spent here: a visitor who only watches the demo costs no
 * run and can post no score. The seed is local and thrown away.
 */
function startDemo(): void {
  attract.stop();
  mode = reducedMotion ? 'idle' : 'attract';
  submitted = false;
  actions = [];
  runId = null;
  // A demo was never going to be posted, so the note would be noise on it.
  ticketProblem = null;
  showRunNote();

  game = new SurgeGame({ seed: randomSeed() });
  runOrigin = performance.now();
  hiddenTotal = 0;
  hiddenSince = document.hidden ? performance.now() : 0;
  game.start(0);

  renderer.clear();
  renderer.sync(game.tiles);
  hideOverlay();
  updateHud(game.snapshot(0));
  els.attract.hidden = false;
  if (mode === 'attract') attract.start();
}

/** Hand the board over: the visitor is playing now. */
function beginPlay(): void {
  if (mode === 'live') return;
  attract.stop();
  mode = 'live';
  els.attract.hidden = true;
  void startRun();
  // First-time visitors get taught the game rather than dropped into it.
  if (!safeGet(TUTORIAL_KEY)) tutorial.start();
}

async function startRun(): Promise<void> {
  if (claiming) return;
  claiming = true;
  attract.stop();
  els.attract.hidden = true;

  // Ask the server for a seed so it can replay and verify the run later. If it
  // is unreachable the game still plays, it just cannot post a score.
  let seed = randomSeed();
  let ticketId: string | null = null;
  const waitingOut = Math.ceil((ticketCooldownUntil - Date.now()) / 1000);

  if (waitingOut > 0) {
    // Still inside the window the server asked for. Do not send the request.
    ticketProblem = `The board asked us to wait ${waitingOut}s before starting another run.`;
  } else {
    try {
      const ticket = await api.startRun();
      seed = ticket.seed;
      ticketId = ticket.runId;
      ticketProblem = null;
      ticketCooldownUntil = 0;
    } catch (error) {
      ticketId = null;
      ticketProblem = apiMessage(error, 'The board is offline.');
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) {
        ticketCooldownUntil = Date.now() + (error.retryAfter ?? 60) * 1000;
      }
    }
  }

  // Everything below is one step, taken only once the seed is settled. Flipping
  // to 'live' before the ticket arrived would log moves made on the demo board
  // against a seed the server never issued, and the replay would reject them.
  mode = 'live';
  claiming = false;
  submitted = false;
  actions = [];
  runId = ticketId;

  game = new SurgeGame({ seed });
  runOrigin = performance.now();
  hiddenTotal = 0;
  hiddenSince = document.hidden ? performance.now() : 0;
  game.start(0);

  renderer.clear();
  renderer.sync(game.tiles);
  hideOverlay();
  updateHud(game.snapshot(0));
  showRunNote();
  announce(ticketProblem ? `New run started. ${ticketProblem} This run cannot be posted.` : 'New run started.');
  publish();
}

/** The standing note under the deck: present exactly when the run cannot count. */
function showRunNote(): void {
  els.runNote.textContent = ticketProblem ? `${ticketProblem} This run cannot be posted.` : '';
  els.runNote.hidden = ticketProblem === null;
}

function record(type: Action['type'], at: number): void {
  // A demo move belongs to nobody, so it never enters the log the server replays.
  if (mode !== 'live') return;
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
  announce('Vented. The board dropped a row; the rise timer keeps running.');
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

  // Attract mode: any key is the coin slot. Tab still walks the page, though —
  // taking the board away from someone who is only navigating would be rude.
  if (mode !== 'live') {
    if (event.key === 'Tab' || event.key === 'Shift') return;
    event.preventDefault();
    beginPlay();
    return;
  }

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
  // The demo does not get to set your personal best.
  if (mode === 'live' && state.score > best) {
    best = state.score;
    safeSet('surge.best', String(best));
  }
  els.best.textContent = formatNumber(best);

  els.combo.textContent = `${state.combo}x`;
  els.combo.classList.toggle('is-hot', state.combo >= 4);
  els.combo.style.setProperty('--combo-fill', String(state.comboRemaining));

  els.level.textContent = String(state.level);

  updateVent(state);
}

/**
 * The vent has three states and they must not look alike.
 *
 * A full meter is not the same thing as an available vent: the valve only
 * re-arms on the next rise, so a fast player can refill the charge and still be
 * locked out. Showing a full bar on a dead button is what makes the control
 * read as broken, so the label names the state it is actually in.
 */
function updateVent(state: GameState): void {
  const ratio = Math.min(1, state.charge / CHARGE_MAX);
  const charged = ratio >= 1;
  const status: 'charging' | 'locked' | 'ready' = !charged
    ? 'charging'
    : state.ventArmed
      ? 'ready'
      : 'locked';

  els.vent.disabled = !state.canVent;
  els.vent.dataset.state = status;
  els.vent.style.setProperty('--charge', String(ratio));

  els.ventLabel.textContent =
    status === 'ready'
      ? 'Vent'
      : status === 'locked'
        ? 'Vent ready at the next rise'
        : `Charging ${Math.round(ratio * 100)}%`;
  // The key hint is a lie on a button that cannot fire.
  els.ventKey.hidden = status !== 'ready';
}

function announce(message: string): void {
  els.status.textContent = message;
}

/* --------------------------------------------------------------- game over */

function finishRun(): void {
  // A demo that dies is not a result. The attract loop deals a fresh board.
  if (mode !== 'live') return;
  if (!els.overlay.hidden) return;
  runEndedAt = engineNow();
  const state = game.snapshot(runEndedAt);

  els.overlayTitle.textContent = 'Buried';
  els.overlayStats.textContent =
    `${formatNumber(state.score)} points · level ${state.level} · ` +
    `${formatNumber(state.merges)} merges · best tile ${formatNumber(state.bestTile)}`;

  const canSave = state.score > 0 && runId !== null && !submitted;
  els.saveForm.hidden = !canSave;
  els.saveStatus.textContent =
    runId === null && state.score > 0 ? (ticketProblem ?? 'This run cannot be posted.') : '';
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
    // The server says why — a rate limit, an exhausted database, an expired
    // ticket — and each of those needs a different thing from the player.
    els.saveStatus.textContent = apiMessage(error, 'This run could not be posted.');
  } finally {
    els.saveButton.disabled = false;
  }
}

/* -------------------------------------------------------------- frame loop */

function frame(): void {
  const at = engineNow();
  // Idle boards do not tick: the floor must not rise on someone who has not
  // started playing. This is the reduced-motion path.
  const tick = mode === 'idle' ? { rises: [], over: false } : game.tick(at);

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
    ventArmed: state.ventArmed,
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
  // Clicking the prompt, or anywhere on the demo board, takes the cabinet.
  els.attract.addEventListener('click', () => beginPlay());
  els.attractStart.addEventListener('click', () => beginPlay());
  els.vent.addEventListener('click', () => applyVent());
  els.howTo.addEventListener('click', () => tutorial.start());
  els.saveForm.addEventListener('submit', (event) => void submitScore(event));

  let touchStart: { x: number; y: number } | null = null;
  canvas.addEventListener(
    'touchstart',
    (event) => {
      if (mode !== 'live') {
        beginPlay();
        return;
      }
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

function boot(): void {
  agent = installAgentApi({
    getState: () => game.snapshot(engineNow()),
    // A bot that starts playing is a player, not an audience: its first call
    // claims the cabinet. That call is spent opening the run — the ticket is a
    // round trip — so a bot loop simply plays its next move on the real board.
    move: (direction) => {
      if (mode !== 'live') return void startRun();
      applyMove(direction);
    },
    vent: () => {
      if (mode !== 'live') return void startRun();
      applyVent();
    },
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

  // The cabinet plays itself until somebody takes it.
  startDemo();

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

boot();
