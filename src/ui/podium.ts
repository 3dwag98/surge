/**
 * The podium beside the game: the three best runs, by score alone.
 *
 * It is fed from the same rows the leaderboard renders, so posting a run
 * updates both without a second round trip.
 */

import { formatNumber } from './leaderboard.js';
import type { ScoreRow } from '../../shared/rules.js';

/** Shown next to each place. Purely decorative; rank is stated in text too. */
const MEDALS = ['1st', '2nd', '3rd'];

export class Podium {
  constructor(private root: HTMLElement) {}

  setRows(rows: readonly ScoreRow[]): void {
    this.root.replaceChildren(...rows.map((row, index) => place(row, index + 1)));
  }
}

/** One place. Player-supplied text goes in as a text node, never as markup. */
function place(row: ScoreRow, rank: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'place';
  wrap.dataset.rank = String(rank);

  const badge = document.createElement('span');
  badge.className = 'place-rank';
  badge.textContent = MEDALS[rank - 1] ?? `#${rank}`;

  const name = document.createElement('span');
  name.className = 'place-name';
  name.textContent = row.name;

  const score = document.createElement('span');
  score.className = 'place-score';
  score.textContent = `${formatNumber(row.score)} pts`;

  const meta = document.createElement('span');
  meta.className = 'place-meta';
  meta.textContent = `level ${row.level} · best tile ${formatNumber(row.bestTile)}`;

  wrap.append(badge, name, score, meta);
  return wrap;
}
