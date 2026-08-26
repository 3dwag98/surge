/**
 * Thin client for the Worker API.
 *
 * Every call degrades rather than throwing at the UI: if the leaderboard is
 * unreachable the game still plays, it just cannot post a score. That matters
 * because the game is the product and the network is not.
 */

import type { ScoreRow } from '../../shared/rules.js';

export interface RunTicket {
  runId: string;
  seed: number;
}

export interface SubmitOutcome {
  rank: number | null;
  entry: ScoreRow;
  scores: ScoreRow[];
  /** The three best runs after this one landed. */
  podium: ScoreRow[];
  /** True when this run was good enough to take a place on the podium. */
  wonPodium: boolean;
  /** The score the server derived by replaying the run. */
  verifiedScore: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TIMEOUT_MS = 8000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError('server sent a malformed response', response.status);
    }
    if (!response.ok) {
      const message =
        (body as { error?: string } | null)?.error ?? `request failed (${response.status})`;
      throw new ApiError(message, response.status);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

export const api = {
  /** Ask the server to open a run and issue the seed it will be replayed with. */
  startRun(): Promise<RunTicket> {
    return request<RunTicket>('/api/runs', json({}));
  },

  /**
   * Submit the run. The client sends what it did, not what it scored — the
   * server replays the log against the seed it issued and keeps its own total.
   */
  finishRun(
    runId: string,
    payload: { name: string; log: string; durationMs: number },
  ): Promise<SubmitOutcome> {
    return request<SubmitOutcome>(`/api/runs/${encodeURIComponent(runId)}/finish`, json(payload));
  },

  scores(limit = 25): Promise<{ scores: ScoreRow[]; podium: ScoreRow[] }> {
    return request<{ scores: ScoreRow[]; podium: ScoreRow[] }>(`/api/scores?limit=${limit}`);
  },
};
