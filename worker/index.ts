/**
 * Cloudflare Worker: the API behind Surge.
 *
 * One job. It issues the seed a run is played with, then replays the submitted
 * move log against that seed to derive the score itself. Clients never send a
 * score, so there is no number to tamper with.
 *
 * Static assets are served by the ASSETS binding, so this Worker sits in front
 * of the built client and only handles /api.
 */

import { Hono } from 'hono';

import { replayEncoded } from '../shared/replay.js';
import {
  LEADERBOARD_LIMIT,
  ValidationError,
  podium,
  rankScores,
  sanitizeName,
  type ScoreRow,
} from '../shared/rules.js';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Per-colo request limiters. Optional so a config without them still boots —
   * a missing limiter fails open, because a limiter that cannot be reached must
   * never be the thing that takes the API down.
   */
  READ_LIMITER?: RateLimit;
  WRITE_LIMITER?: RateLimit;
  /**
   * Cloudflare Web Analytics site token. Optional: with no token the beacon is
   * never injected and the page ships exactly as built.
   */
  WEB_ANALYTICS_TOKEN?: string;
}

/** A run ticket expires if it is not submitted; stops seeds being farmed. */
const RUN_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 96 * 1024;

/** What a 429 asks the caller to wait, matching the limiter's window. */
const RETRY_AFTER_SECONDS = 60;

/** How deep to look when working out who is on the podium. */
const PODIUM_POOL = 60;

const app = new Hono<{ Bindings: Env }>();

/* ------------------------------------------------------------------ utils */

const nowIso = () => new Date().toISOString();

function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Spend one unit of a rate limit budget.
 *
 * The key is the caller's IP, which the Rate Limiting docs rightly warn about —
 * people behind one mobile carrier share an address. That is an acceptable cost
 * here: there is no account to key on, the budgets are set well above what any
 * one person does, and the alternative is letting a single script spend the
 * whole day's free-tier allowance in a couple of minutes.
 *
 * A limiter that is missing or throwing fails open. It is a guard rail, not a
 * dependency, and it must never be the reason the game stops working.
 */
async function overBudget(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

/** The one shape a rate-limited caller ever sees. */
function tooMany(): Response {
  return Response.json(
    { error: 'too many requests right now — try again in a minute', retryable: true },
    { status: 429, headers: { 'retry-after': String(RETRY_AFTER_SECONDS) } },
  );
}

function seed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

const SCORE_COLUMNS = `id, name, score, level, best_tile AS bestTile, merges,
                       duration_ms AS durationMs, created_at AS createdAt`;

function topScores(env: Env, limit: number): Promise<D1Result<ScoreRow>> {
  return env.DB.prepare(
    `SELECT ${SCORE_COLUMNS}
       FROM scores
      ORDER BY score DESC, best_tile DESC, created_at ASC
      LIMIT ?1`,
  )
    .bind(limit)
    .all<ScoreRow>();
}

/* ------------------------------------------------------------------ scores */

app.get('/api/scores', async (c) => {
  if (await overBudget(c.env.READ_LIMITER, clientIp(c.req.raw))) return tooMany();

  const requested = Number(c.req.query('limit'));
  const limit =
    Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : LEADERBOARD_LIMIT;

  // Read deep enough to settle the podium in the same query: it needs a pool
  // bigger than the page when one player holds several of the top rows.
  const { results } = await topScores(c.env, Math.max(limit, PODIUM_POOL));
  const pool = results ?? [];
  return c.json({ scores: rankScores(pool, limit), podium: podium(pool) });
});

/** Open a run: the server picks the seed so it can replay the result later. */
app.post('/api/runs', async (c) => {
  const ip = clientIp(c.req.raw);
  // This used to be a COUNT over the runs table, which meant a flood of run
  // requests was answered by hammering the database it was meant to protect.
  // The limiter costs no query at all.
  if (await overBudget(c.env.WRITE_LIMITER, ip)) return tooMany();

  const runId = newId();
  const runSeed = seed();
  await c.env.DB.prepare(
    `INSERT INTO runs (id, seed, ip, created_at, status) VALUES (?1, ?2, ?3, ?4, 'open')`,
  )
    .bind(runId, runSeed, ip, nowIso())
    .run();

  return c.json({ runId, seed: runSeed });
});

/**
 * Finish a run. The body carries the move log, not a score: we replay it
 * against the seed we issued and record whatever the engine produces.
 */
app.post('/api/runs/:id/finish', async (c) => {
  // Submitting is the most expensive thing this Worker does — it replays the
  // whole run — so it is metered on the same budget as opening one.
  if (await overBudget(c.env.WRITE_LIMITER, clientIp(c.req.raw))) return tooMany();

  const runId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'body must be JSON' }, 400);

  const { name, log, durationMs } = body as {
    name?: unknown;
    log?: unknown;
    durationMs?: unknown;
  };
  if (typeof log !== 'string') return c.json({ error: 'log is required' }, 400);
  if (log.length > MAX_LOG_BYTES) return c.json({ error: 'log is too large' }, 413);
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return c.json({ error: 'durationMs is required' }, 400);
  }

  const run = await c.env.DB.prepare(
    `SELECT id, seed, status, created_at AS createdAt FROM runs WHERE id = ?1`,
  )
    .bind(runId)
    .first<{ id: string; seed: number; status: string; createdAt: string }>();

  if (!run) return c.json({ error: 'unknown run' }, 404);
  // One submission per ticket: a seed cannot be replayed for a better score.
  if (run.status !== 'open') return c.json({ error: 'this run was already submitted' }, 409);
  if (Date.now() - Date.parse(run.createdAt) > RUN_TTL_MS) {
    await c.env.DB.prepare(`UPDATE runs SET status = 'expired' WHERE id = ?1`).bind(runId).run();
    return c.json({ error: 'this run expired' }, 410);
  }

  const outcome = replayEncoded(run.seed, log, Math.round(durationMs));
  if (!outcome.ok) {
    await c.env.DB.prepare(`UPDATE runs SET status = 'rejected' WHERE id = ?1`).bind(runId).run();
    return c.json({ error: `run rejected: ${outcome.reason}` }, 400);
  }
  if (outcome.score <= 0) {
    await c.env.DB.prepare(`UPDATE runs SET status = 'empty' WHERE id = ?1`).bind(runId).run();
    return c.json({ error: 'that run scored nothing' }, 400);
  }

  const entry: ScoreRow = {
    id: newId(),
    name: sanitizeName(name),
    score: outcome.score,
    level: outcome.level,
    bestTile: outcome.bestTile,
    merges: outcome.merges,
    durationMs: outcome.durationMs,
    createdAt: nowIso(),
  };

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO scores (id, run_id, name, score, level, best_tile, merges, duration_ms, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      entry.id,
      runId,
      entry.name,
      entry.score,
      entry.level,
      entry.bestTile,
      entry.merges,
      entry.durationMs,
      entry.createdAt,
    ),
    c.env.DB.prepare(`UPDATE runs SET status = 'submitted' WHERE id = ?1`).bind(runId),
  ]);

  const { results } = await topScores(c.env, PODIUM_POOL);
  const pool = results ?? [];
  const scores = rankScores(pool, LEADERBOARD_LIMIT);
  const index = scores.findIndex((row) => row.id === entry.id);
  const places = podium(pool);

  return c.json(
    {
      rank: index === -1 ? null : index + 1,
      entry,
      scores,
      podium: places,
      /** Did this run take a place on the podium? */
      wonPodium: places.some((row) => row.id === entry.id),
      verifiedScore: outcome.score,
    },
    201,
  );
});

/* ------------------------------------------------------------------ misc */

/**
 * Liveness, and — with `?db=1` — one cheap query to prove the database is
 * still answering. The database check is opt-in because a monitor polling it
 * every minute would itself spend the daily row allowance it is watching.
 */
app.get('/api/health', async (c) => {
  const body: Record<string, unknown> = {
    ok: true,
    analytics: Boolean(c.env.WEB_ANALYTICS_TOKEN),
    time: nowIso(),
  };

  if (c.req.query('db')) {
    try {
      await c.env.DB.prepare('SELECT 1').first();
      body.db = 'ok';
    } catch (error) {
      body.db = outOfAllowance(error) ? 'over-limit' : 'unavailable';
      body.ok = false;
    }
  }

  return c.json(body, body.ok ? 200 : 503);
});

app.all('/api/*', (c) => c.json({ error: 'unknown endpoint' }, 404));

/**
 * A D1 failure is not a bug in this Worker, and answering it with "internal
 * error" tells the player nothing they can act on. The two cases worth telling
 * apart are the database being out of its daily allowance — which fixes itself
 * at the reset and means nobody can post today — and it being unreachable,
 * which is worth retrying now.
 */
function isDatabaseError(error: unknown): boolean {
  return error instanceof Error && /D1_ERROR|D1_EXCEPTION|SQLITE_/.test(error.message);
}

function outOfAllowance(error: unknown): boolean {
  return (
    error instanceof Error &&
    /limit|quota|exceeded|exhausted|too many/i.test(error.message)
  );
}

app.onError((error, c) => {
  if (error instanceof ValidationError) return c.json({ error: error.message }, 400);

  if (isDatabaseError(error)) {
    console.error('[worker] database', error);
    return c.json(
      outOfAllowance(error)
        ? {
            error:
              'the leaderboard has used up its database allowance for today — the game still plays, but scores cannot be posted until it resets',
            retryable: false,
          }
        : { error: 'the leaderboard database is unreachable right now', retryable: true },
      503,
      { 'retry-after': String(RETRY_AFTER_SECONDS) },
    );
  }

  console.error('[worker]', error);
  return c.json({ error: 'internal error' }, 500);
});

/**
 * Everything that is not /api is the built client.
 *
 * HTML gets the Cloudflare Web Analytics beacon appended on the way out, when a
 * site token is configured. Injecting here rather than in index.html keeps the
 * token out of the repository and off every non-HTML response, and means a
 * deployment without one serves the page untouched — there is no placeholder to
 * forget about. The beacon sets no cookies and collects nothing that would need
 * a consent banner.
 */
app.all('*', async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const token = c.env.WEB_ANALYTICS_TOKEN;
  if (!token || !/^[a-f0-9]{8,64}$/i.test(token)) return response;
  if (!response.headers.get('content-type')?.includes('text/html')) return response;

  return new HTMLRewriter()
    .on('body', {
      element(element) {
        element.append(
          `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
            `data-cf-beacon='{"token":"${token}"}'></script>`,
          { html: true },
        );
      },
    })
    .transform(response);
});

export default app;
