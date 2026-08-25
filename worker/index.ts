/**
 * Cloudflare Worker: the API behind Surge.
 *
 * Two jobs.
 *
 * 1. The leaderboard. It issues the seed a run is played with, then replays the
 *    submitted move log against that seed to derive the score itself. Clients
 *    never send a score, so there is no number to tamper with.
 *
 * 2. The banner. One slot, held by the highest bidder. A claim becomes live the
 *    instant PayPal confirms the money cleared — verified by capturing
 *    server-side, never by trusting the browser's word for it.
 *
 * Static assets are served by the ASSETS binding, so this Worker sits in front
 * of the built client and only handles /api.
 */

import { Hono } from 'hono';

import { replayEncoded } from '../shared/replay.js';
import {
  LEADERBOARD_LIMIT,
  ValidationError,
  minimumClaimCents,
  parseUsdToCents,
  rankScores,
  sanitizeBannerText,
  sanitizeBannerUrl,
  sanitizeName,
  type ScoreRow,
} from '../shared/rules.js';
import { PayPalClient, PayPalError, readPayPalConfig } from './paypal.js';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_ENVIRONMENT?: string;
  PAYPAL_WEBHOOK_ID?: string;
  CURRENCY?: string;
}

/** A run ticket expires if it is not submitted; stops seeds being farmed. */
const RUN_TTL_MS = 3 * 60 * 60 * 1000;
/** Cheap abuse guard on run creation, per IP. */
const RUN_RATE_LIMIT = 60;
const RUN_RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 96 * 1024;

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

function seed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

function currencyOf(env: Env): string {
  return env.CURRENCY && /^[A-Z]{3}$/.test(env.CURRENCY) ? env.CURRENCY : 'USD';
}

/* ------------------------------------------------------------------ scores */

app.get('/api/scores', async (c) => {
  const requested = Number(c.req.query('limit'));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : LEADERBOARD_LIMIT;

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, score, level, best_tile AS bestTile, merges, duration_ms AS durationMs,
            created_at AS createdAt
       FROM scores
      ORDER BY score DESC, best_tile DESC, created_at ASC
      LIMIT ?1`,
  )
    .bind(limit)
    .all<ScoreRow>();

  return c.json({ scores: rankScores(results ?? [], limit) });
});

/** Open a run: the server picks the seed so it can replay the result later. */
app.post('/api/runs', async (c) => {
  const ip = clientIp(c.req.raw);
  const since = new Date(Date.now() - RUN_RATE_WINDOW_MS).toISOString();

  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM runs WHERE ip = ?1 AND created_at > ?2`,
  )
    .bind(ip, since)
    .first<{ n: number }>();

  if ((recent?.n ?? 0) >= RUN_RATE_LIMIT) {
    return c.json({ error: 'too many runs started, slow down' }, 429);
  }

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
  const runId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'body must be JSON' }, 400);

  const { name, log, durationMs } = body as { name?: unknown; log?: unknown; durationMs?: unknown };
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

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, score, level, best_tile AS bestTile, merges, duration_ms AS durationMs,
            created_at AS createdAt
       FROM scores
      ORDER BY score DESC, best_tile DESC, created_at ASC
      LIMIT ?1`,
  )
    .bind(LEADERBOARD_LIMIT)
    .all<ScoreRow>();

  const scores = rankScores(results ?? [], LEADERBOARD_LIMIT);
  const index = scores.findIndex((row) => row.id === entry.id);

  return c.json(
    { rank: index === -1 ? null : index + 1, entry, scores, verifiedScore: outcome.score },
    201,
  );
});

/* ------------------------------------------------------------------ banner */

interface BannerRow {
  id: string;
  text: string;
  url: string;
  name: string;
  amount_cents: number;
  claimed_at: string;
}

async function currentBanner(env: Env): Promise<BannerRow | null> {
  return env.DB.prepare(
    `SELECT id, text, url, name, amount_cents, claimed_at
       FROM banner_claims
      WHERE status = 'live'
      ORDER BY amount_cents DESC, claimed_at ASC
      LIMIT 1`,
  ).first<BannerRow>();
}

const bannerJson = (row: BannerRow | null) =>
  row
    ? {
        text: row.text,
        url: row.url,
        name: row.name,
        amountCents: row.amount_cents,
        claimedAt: row.claimed_at,
      }
    : null;

app.get('/api/banner', async (c) => {
  const row = await currentBanner(c.env);
  const config = readPayPalConfig(c.env as unknown as Record<string, unknown>);

  return c.json({
    banner: bannerJson(row),
    minimumCents: minimumClaimCents(row?.amount_cents ?? null),
    // The client only ever learns the public id, never the secret.
    paypalClientId: config?.clientId ?? null,
    paypalEnvironment: config?.environment ?? null,
    currency: currencyOf(c.env),
  });
});

/** Stage a claim and open a PayPal order for it. Nothing goes live yet. */
app.post('/api/banner/orders', async (c) => {
  const config = readPayPalConfig(c.env as unknown as Record<string, unknown>);
  if (!config) return c.json({ error: 'payments are not configured on this deployment' }, 503);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'body must be JSON' }, 400);

  const raw = body as { text?: unknown; url?: unknown; name?: unknown; amountUsd?: unknown };

  let text: string;
  let url: string;
  let amountCents: number;
  try {
    text = sanitizeBannerText(raw.text);
    url = sanitizeBannerUrl(raw.url);
    amountCents = parseUsdToCents(raw.amountUsd);
  } catch (error) {
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    throw error;
  }

  const existing = await currentBanner(c.env);
  const minimum = minimumClaimCents(existing?.amount_cents ?? null);
  if (amountCents < minimum) {
    return c.json({ error: `bid at least ${(minimum / 100).toFixed(2)}`, minimumCents: minimum }, 409);
  }

  const claimId = newId();
  const paypal = new PayPalClient(config);

  let order: { id: string };
  try {
    order = await paypal.createOrder({
      amountCents,
      currency: currencyOf(c.env),
      description: `SURGE banner — ${text}`,
      referenceId: claimId,
    });
  } catch (error) {
    if (error instanceof PayPalError) return c.json({ error: error.message }, error.status as 400 | 502);
    throw error;
  }

  await c.env.DB.prepare(
    `INSERT INTO banner_claims
       (id, order_id, text, url, name, amount_cents, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`,
  )
    .bind(claimId, order.id, text, url, sanitizeName(raw.name), amountCents, nowIso())
    .run();

  return c.json({ orderId: order.id, minimumCents: minimum }, 201);
});

/**
 * Capture an approved order. This is the only path that puts a banner live,
 * and it only does so on PayPal's confirmation of a completed capture.
 */
app.post('/api/banner/orders/:orderId/capture', async (c) => {
  const config = readPayPalConfig(c.env as unknown as Record<string, unknown>);
  if (!config) return c.json({ error: 'payments are not configured' }, 503);

  const orderId = c.req.param('orderId');
  const paypal = new PayPalClient(config);

  try {
    const banner = await settleOrder(c.env, paypal, orderId);
    if (!banner) return c.json({ error: 'that payment has not completed' }, 402);
    return c.json({ banner });
  } catch (error) {
    if (error instanceof PayPalError) return c.json({ error: error.message }, error.status as 400 | 502);
    throw error;
  }
});

/**
 * Take a captured order and, if the money really cleared, hand the banner over.
 *
 * Shared by the browser capture call and the webhook so both arrive at the same
 * state — whichever gets there first wins and the other is a no-op.
 */
async function settleOrder(
  env: Env,
  paypal: PayPalClient,
  orderId: string,
  alreadyCaptured = false,
): Promise<ReturnType<typeof bannerJson>> {
  const claim = await env.DB.prepare(
    `SELECT id, order_id, text, url, name, amount_cents, status, claimed_at
       FROM banner_claims WHERE order_id = ?1`,
  )
    .bind(orderId)
    .first<BannerRow & { order_id: string; status: string }>();

  if (!claim) return null;
  // Already settled: return what is live rather than double-charging anything.
  if (claim.status === 'live') return bannerJson(claim);

  const captured = alreadyCaptured ? await paypal.getOrder(orderId) : await paypal.captureOrder(orderId);
  if (captured.status !== 'COMPLETED') return null;

  // Trust the amount PayPal says cleared, not the one the client asked for.
  const paidCents = captured.amountCents;
  const standing = await currentBanner(env);
  if (paidCents < minimumClaimCents(standing?.amount_cents ?? null)) {
    // Someone outbid them while the PayPal window was open. Keep the record so
    // the money is traceable, but do not hand over the slot.
    await env.DB.prepare(
      `UPDATE banner_claims SET status = 'outbid', amount_cents = ?2, capture_id = ?3 WHERE id = ?1`,
    )
      .bind(claim.id, paidCents, captured.captureId)
      .run();
    return null;
  }

  const claimedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE banner_claims SET status = 'retired' WHERE status = 'live'`),
    env.DB.prepare(
      `UPDATE banner_claims
          SET status = 'live', amount_cents = ?2, capture_id = ?3, claimed_at = ?4
        WHERE id = ?1`,
    ).bind(claim.id, paidCents, captured.captureId, claimedAt),
  ]);

  return bannerJson({ ...claim, amount_cents: paidCents, claimed_at: claimedAt });
}

/**
 * PayPal webhook. A second, independent path to the same settlement, so a
 * browser that closes mid-capture does not strand a paid claim.
 */
app.post('/api/paypal/webhook', async (c) => {
  const config = readPayPalConfig(c.env as unknown as Record<string, unknown>);
  if (!config?.webhookId) return c.json({ error: 'webhooks are not configured' }, 503);

  const raw = await c.req.text();
  const paypal = new PayPalClient(config);

  // Never act on an unverified webhook: it decides who owns the banner.
  const verified = await paypal.verifyWebhook(c.req.raw.headers, raw);
  if (!verified) return c.json({ error: 'signature verification failed' }, 401);

  const event = JSON.parse(raw) as {
    event_type?: string;
    resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } };
  };

  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED' && event.event_type !== 'CHECKOUT.ORDER.APPROVED') {
    return c.json({ ok: true, ignored: event.event_type ?? 'unknown' });
  }

  const orderId =
    event.resource?.supplementary_data?.related_ids?.order_id ??
    (event.event_type === 'CHECKOUT.ORDER.APPROVED' ? event.resource?.id : undefined);
  if (!orderId) return c.json({ ok: true, ignored: 'no order id' });

  const alreadyCaptured = event.event_type === 'PAYMENT.CAPTURE.COMPLETED';
  await settleOrder(c.env, paypal, orderId, alreadyCaptured).catch(() => null);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ misc */

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    paypal: readPayPalConfig(c.env as unknown as Record<string, unknown>) !== null,
    time: nowIso(),
  }),
);

app.all('/api/*', (c) => c.json({ error: 'unknown endpoint' }, 404));

app.onError((error, c) => {
  if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
  console.error('[worker]', error);
  return c.json({ error: 'internal error' }, 500);
});

/** Everything that is not /api is the built client. */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
