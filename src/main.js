/**
 * Browser entry point: renders the board, handles input, and talks to the
 * leaderboard. All game rules live in game.js; this module only draws them.
 */

import { Game } from './game.js';
import { createStorage } from './storage.js';
import { createLeaderboard } from './leaderboard.js';
import { LEADERBOARD_LIMIT, MAX_NAME_LENGTH, sanitizeName } from './scores.js';

const SAVE_KEY = '2048.save';
const BEST_KEY = '2048.best';
const NAME_KEY = '2048.name';

/** Minimum swipe distance, in px, before a drag counts as a move. */
const SWIPE_THRESHOLD = 24;

const KEY_DIRECTIONS = {
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

const $ = (selector) => document.querySelector(selector);

const els = {
  board: $('#board'),
  grid: $('#grid'),
  tiles: $('#tiles'),
  score: $('#score'),
  best: $('#best'),
  scoreAddition: $('#score-addition'),
  status: $('#board-status'),
  newGame: $('#new-game'),
  overlay: $('#overlay'),
  overlayTitle: $('#overlay-title'),
  overlayMessage: $('#overlay-message'),
  saveForm: $('#save-form'),
  saveLabel: $('#save-label'),
  playerName: $('#player-name'),
  saveStatus: $('#save-status'),
  keepGoing: $('#keep-going'),
  playAgain: $('#play-again'),
  leaderboardTable: $('#leaderboard-table'),
  leaderboardBody: $('#leaderboard-body'),
  leaderboardEmpty: $('#leaderboard-empty'),
  leaderboardSource: $('#leaderboard-source'),
  clearScores: $('#clear-scores'),
};

const storage = createStorage(safeLocalStorage());
const leaderboard = createLeaderboard({ storage });

/** Slide duration in ms, read from CSS so the two cannot drift apart. */
const MOVE_MS = readCssDuration('--move-duration', 110);

const tileElements = new Map();

let game;
let best = Number(storage.getItem(BEST_KEY)) || 0;
let startedAt = Date.now();
let runSaved = false;
let lastEntryId = null;
let leaderboardEntries = [];

boot();

/* ------------------------------------------------------------------ setup */

function boot() {
  game = restoreGame() ?? newGame();
  els.board.style.setProperty('--cells', String(game.size));
  buildGrid(game.size);
  renderAll();
  updateScores({ animate: false });

  if (game.over) {
    showGameOver();
  } else if (game.won && !game.keepPlaying) {
    showWin();
  }

  bindEvents();
  els.playerName.value = storage.getItem(NAME_KEY) ?? '';
  refreshLeaderboard();
}

function newGame() {
  startedAt = Date.now();
  runSaved = false;
  return new Game();
}

function restoreGame() {
  const saved = storage.getJSON(SAVE_KEY);
  if (!saved) return null;
  try {
    const restored = Game.fromJSON(saved);
    startedAt = Number.isFinite(saved.startedAt) ? saved.startedAt : Date.now();
    runSaved = Boolean(saved.runSaved);
    return restored;
  } catch {
    // A snapshot from an older version, or hand-edited storage: start fresh.
    storage.removeItem(SAVE_KEY);
    return null;
  }
}

function persistGame() {
  storage.setJSON(SAVE_KEY, { ...game.toJSON(), startedAt, runSaved });
}

function buildGrid(size) {
  const cells = Array.from({ length: size * size }, () => {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    return cell;
  });
  els.grid.replaceChildren(...cells);
}

function bindEvents() {
  window.addEventListener('keydown', onKeyDown);
  els.newGame.addEventListener('click', startNewGame);
  els.playAgain.addEventListener('click', startNewGame);

  els.keepGoing.addEventListener('click', () => {
    game.continuePlaying();
    persistGame();
    hideOverlay();
  });

  els.saveForm.addEventListener('submit', onSaveScore);
  els.clearScores.addEventListener('click', onClearScores);

  let touchStart = null;
  els.board.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      touchStart = { x: touch.clientX, y: touch.clientY };
    },
    { passive: true },
  );

  els.board.addEventListener('touchend', (event) => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    touchStart = null;

    const direction = swipeDirection(dx, dy);
    if (direction) {
      event.preventDefault();
      applyMove(direction);
    }
  });

  els.board.addEventListener('touchcancel', () => {
    touchStart = null;
  });
}

/* ------------------------------------------------------------------ input */

function onKeyDown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (isTypingTarget(event.target)) return;

  const direction = KEY_DIRECTIONS[event.key.toLowerCase()];
  if (!direction) return;

  event.preventDefault(); // arrows would otherwise scroll the page
  applyMove(direction);
}

function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function swipeDirection(dx, dy) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/* ------------------------------------------------------------------- turn */

function applyMove(direction) {
  // While an overlay is up the run is finished (or paused on a win); the only
  // way forward is one of its buttons.
  if (!els.overlay.hidden) return;

  const result = game.move(direction);
  if (!result.moved) return;

  renderMove(result);
  updateScores({ gained: result.scoreGained });
  persistGame();

  if (result.justWon && !game.keepPlaying) {
    showWin();
  } else if (result.over) {
    showGameOver();
  }
}

function startNewGame() {
  game = newGame();
  hideOverlay();
  renderAll();
  updateScores({ animate: false });
  persistGame();
  announce('New game started.');
}

/* --------------------------------------------------------------- renderer */

function createTileElement() {
  const el = document.createElement('div');
  el.className = 'tile';
  const inner = document.createElement('div');
  inner.className = 'tile-inner';
  el.append(inner);
  return el;
}

function paintTile(el, tile) {
  const value = String(tile.value);
  el.dataset.value = value;
  el.dataset.digits = String(value.length);
  el.classList.toggle('tile-super', tile.value > 2048);
  el.style.setProperty('--row', String(tile.row));
  el.style.setProperty('--col', String(tile.col));
  el.firstChild.textContent = value;
}

/** Draw the whole board with no animation (new game, or restored save). */
function renderAll() {
  tileElements.clear();
  const nodes = game.tiles.map((tile) => {
    const el = createTileElement();
    paintTile(el, tile);
    tileElements.set(tile.id, el);
    return el;
  });
  els.tiles.replaceChildren(...nodes);
}

/** Animate one move: survivors slide, merged sources fade out, new tiles pop. */
function renderMove(result) {
  // Tiles consumed by a merge travel into the merge cell, then leave the DOM.
  for (const ghost of result.removed) {
    const el = tileElements.get(ghost.id);
    if (!el) continue;
    tileElements.delete(ghost.id);
    el.classList.add('is-ghost');
    el.style.setProperty('--row', String(ghost.row));
    el.style.setProperty('--col', String(ghost.col));
    window.setTimeout(() => el.remove(), MOVE_MS + 30);
  }

  const added = [];
  for (const tile of game.tiles) {
    const existing = tileElements.get(tile.id);
    if (existing) {
      paintTile(existing, tile); // transitions to its new cell
      continue;
    }
    // Position new tiles before they enter the DOM so they pop into place
    // instead of sliding in from the top-left corner.
    const el = createTileElement();
    paintTile(el, tile);
    if (tile.mergedFrom) el.classList.add('is-merged');
    if (tile.isNew) el.classList.add('is-new');
    tileElements.set(tile.id, el);
    added.push(el);
  }
  if (added.length) els.tiles.append(...added);
}

function updateScores({ gained = 0, animate = true } = {}) {
  els.score.textContent = formatNumber(game.score);

  if (game.score > best) {
    best = game.score;
    storage.setItem(BEST_KEY, String(best));
  }
  els.best.textContent = formatNumber(best);

  if (gained > 0 && animate) {
    const addition = els.scoreAddition;
    addition.textContent = `+${formatNumber(gained)}`;
    addition.classList.remove('is-active');
    void addition.offsetWidth; // restart the animation
    addition.classList.add('is-active');
    announce(`Score ${game.score}.`);
  }
}

function announce(message) {
  els.status.textContent = message;
}

/* --------------------------------------------------------------- overlays */

function showWin() {
  els.overlay.classList.add('is-win');
  els.overlayTitle.textContent = 'You win!';
  els.overlayMessage.textContent = `You reached 2048 with ${formatNumber(game.score)} points. Keep going for a bigger tile?`;
  els.saveForm.hidden = true;
  els.keepGoing.hidden = false;
  els.playAgain.textContent = 'Start over';
  els.overlay.hidden = false;
  els.keepGoing.focus();
  announce('You reached 2048.');
}

function showGameOver() {
  els.overlay.classList.remove('is-win');
  els.overlayTitle.textContent = 'Game over';
  els.overlayMessage.textContent =
    `${formatNumber(game.score)} points, best tile ${formatNumber(game.bestTile)}, ` +
    `${formatNumber(game.moves)} moves.`;
  els.keepGoing.hidden = true;
  els.playAgain.textContent = 'Play again';

  const canSave = game.score > 0 && !runSaved;
  els.saveForm.hidden = !canSave;
  els.saveLabel.textContent = leaderboard.qualifies(leaderboardEntries, game.score)
    ? 'Add your run to the leaderboard'
    : 'Save this run anyway';
  els.saveStatus.textContent = '';
  els.saveStatus.classList.remove('is-error');
  els.overlay.hidden = false;

  if (canSave) els.playerName.focus();
  else els.playAgain.focus();

  announce(`Game over. Final score ${game.score}.`);
}

function hideOverlay() {
  els.overlay.hidden = true;
  els.overlay.classList.remove('is-win');
}

/* ------------------------------------------------------------ leaderboard */

async function refreshLeaderboard() {
  try {
    const { entries, source } = await leaderboard.list();
    leaderboardEntries = entries;
    renderLeaderboard(entries, source);
  } catch (error) {
    console.warn('[leaderboard] could not load scores', error);
    renderLeaderboard([], leaderboard.source ?? 'local');
  }
}

async function onSaveScore(event) {
  event.preventDefault();
  if (runSaved) return;

  const name = sanitizeName(els.playerName.value);
  const submitButton = els.saveForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  els.saveStatus.classList.remove('is-error');
  els.saveStatus.textContent = 'Saving…';

  try {
    const { entries, rank, source, entryId } = await leaderboard.submit({
      name,
      score: game.score,
      bestTile: game.bestTile,
      moves: game.moves,
      durationMs: Math.max(0, Date.now() - startedAt),
    });

    runSaved = true;
    lastEntryId = entryId ?? null;
    leaderboardEntries = entries;
    storage.setItem(NAME_KEY, name);
    persistGame();

    renderLeaderboard(entries, source, lastEntryId);
    els.saveForm.hidden = true;
    els.overlayMessage.textContent = rank
      ? `${formatNumber(game.score)} points — that is #${rank} on the board.`
      : `${formatNumber(game.score)} points. Not quite a top ${LEADERBOARD_LIMIT} run this time.`;
    els.playAgain.focus();
  } catch (error) {
    els.saveStatus.classList.add('is-error');
    els.saveStatus.textContent = `Could not save: ${error.message ?? 'unknown error'}`;
  } finally {
    submitButton.disabled = false;
  }
}

function onClearScores() {
  if (!window.confirm('Clear the scores saved in this browser? This cannot be undone.')) return;
  leaderboard.clearLocal();
  lastEntryId = null;
  refreshLeaderboard();
}

function renderLeaderboard(entries, source, highlightId = lastEntryId) {
  const rows = entries.map((entry, index) => {
    const tr = document.createElement('tr');
    if (highlightId && entry.id === highlightId) tr.classList.add('is-mine');

    tr.append(
      textCell('col-rank', String(index + 1)),
      textCell('col-name', entry.name || 'Anonymous'),
      textCell('col-score', formatNumber(entry.score)),
      tileCell(entry.bestTile),
      textCell('col-when', formatWhen(entry.createdAt)),
    );
    return tr;
  });

  els.leaderboardBody.replaceChildren(...rows);
  els.leaderboardTable.hidden = rows.length === 0;
  els.leaderboardEmpty.hidden = rows.length > 0;

  const shared = source === 'server';
  els.leaderboardSource.textContent = shared ? 'Shared' : 'This browser';
  els.leaderboardSource.title = shared
    ? 'Scores are stored on the server and shared by everyone playing here.'
    : 'No server available, so scores are kept in this browser only.';
  els.clearScores.hidden = shared || rows.length === 0;
}

function textCell(className, text) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text; // never innerHTML: names are player-supplied
  return td;
}

function tileCell(value) {
  const td = document.createElement('td');
  td.className = 'col-tile';
  if (value) {
    const chip = document.createElement('span');
    chip.className = 'tile-chip';
    chip.textContent = formatNumber(value);
    td.append(chip);
  } else {
    td.textContent = '—';
  }
  return td;
}

/* ------------------------------------------------------------------ utils */

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString();
}

function formatWhen(iso) {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return '—';

  const diff = Date.now() - time;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return formatter.format(-Math.round(diff / ms), unit);
  }
  return formatter.format(0, 'second');
}

function readCssDuration(property, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  if (raw.endsWith('ms')) return Number.parseFloat(raw) || fallback;
  if (raw.endsWith('s')) return (Number.parseFloat(raw) || fallback / 1000) * 1000;
  return fallback;
}

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined; // blocked entirely by browser settings
  }
}

// Keep the input's limit in step with the shared rule.
els.playerName.maxLength = MAX_NAME_LENGTH;
