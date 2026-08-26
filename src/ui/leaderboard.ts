/**
 * The high-score table. Free to enter: play well and you are on it.
 */

import { api } from '../net/api.js';
import type { ScoreRow } from '../../shared/rules.js';

export interface LeaderboardElements {
  body: HTMLElement;
  empty: HTMLElement;
  table: HTMLElement;
  status: HTMLElement;
}

export class LeaderboardView {
  private rows: ScoreRow[] = [];
  private highlightId: string | null = null;

  constructor(private els: LeaderboardElements) {}

  get entries(): readonly ScoreRow[] {
    return this.rows;
  }

  /**
   * Reload the table. The podium comes back on the same response, and is
   * returned rather than rendered here so this view owns only the table.
   */
  async refresh(): Promise<ScoreRow[]> {
    try {
      const { scores, podium } = await api.scores();
      this.rows = scores;
      this.render();
      this.els.status.textContent = '';
      return podium;
    } catch {
      this.els.status.textContent = 'Scores are offline right now.';
      return [];
    }
  }

  highlight(id: string | null): void {
    this.highlightId = id;
    this.render();
  }

  setRows(rows: ScoreRow[]): void {
    this.rows = rows;
    this.render();
  }

  private render(): void {
    const rows = this.rows.map((row, index) => {
      const tr = document.createElement('tr');
      if (this.highlightId && row.id === this.highlightId) tr.classList.add('is-mine');
      if (index === 0) tr.classList.add('is-leader');

      tr.append(
        cell('rank', `${index + 1}`),
        cell('name', row.name || 'anon'),
        cell('score', formatNumber(row.score)),
        cell('level', `${row.level}`),
        chipCell(row.bestTile),
        cell('when', relativeTime(row.createdAt)),
      );
      return tr;
    });

    this.els.body.replaceChildren(...rows);
    this.els.table.hidden = rows.length === 0;
    this.els.empty.hidden = rows.length > 0;
  }
}

function cell(className: string, text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = `col-${className}`;
  td.textContent = text; // player-supplied: never innerHTML
  return td;
}

function chipCell(value: number): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'col-tile';
  if (value > 0) {
    const chip = document.createElement('span');
    chip.className = 'tile-chip';
    chip.dataset.value = String(value);
    chip.textContent = formatNumber(value);
    td.append(chip);
  } else {
    td.textContent = '—';
  }
  return td;
}

export function formatNumber(value: number): string {
  return Number(value ?? 0).toLocaleString();
}

export function relativeTime(iso: string): string {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return '—';

  const diff = Date.now() - time;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
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
