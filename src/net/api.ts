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
    /** Seconds the server asked us to wait, when it said. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A sentence to put in front of the player.
 *
 * The Worker already writes its own errors in plain language, so the job here
 * is punctuation, not translation — inventing a friendlier message would only
 * hide which of the several possible things actually went wrong. The one case
 * with nothing to quote is a response that never reached the Worker at all:
 * over the daily request allowance, Cloudflare answers before the Worker runs,
 * and what comes back is an error page rather than JSON.
 */
export function apiMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const text = error.message.trim();
  if (!text) return fallback;
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
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
    const retryAfter = Number(response.headers.get('retry-after')) || null;
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON. Something answered before the Worker did — an edge error page
      // is what being over the daily request allowance looks like from here.
      throw new ApiError(
        'the server is not answering right now, which usually means it is over its daily limit',
        response.status,
        retryAfter,
      );
    }
    if (!response.ok) {
      const message =
        (body as { error?: string } | null)?.error ?? `request failed (${response.status})`;
      throw new ApiError(message, response.status, retryAfter);
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
