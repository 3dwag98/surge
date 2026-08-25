# SURGE

A tile-merging arcade game where the floor keeps rising, wrapped in a public
board you bid your way onto — and three slots beside it that money cannot buy.

Slide a 5x5 board and merge equal tiles. Unlike 2048, the board is under
constant pressure: rows push in from the bottom on a timer that tightens as you
level, and anything left in the **top row** when a row rises is crushed. There
is no winning tile — you play for score until the board buries you.

**Playing is free and always will be.** Money buys a rank on the board at the
side of the page. It never buys a position on the game board, a score, or one of
the three earned slots.

---

## What makes it not-2048

| Mechanic | What it does |
|---|---|
| **Rising floor** | Every few seconds a partial row shoves in from below and everything moves up one. The interval shrinks with every level. Being caught in the top row is the only way to lose. |
| **Combo window** | Each merge opens a 2.6 s window. Merge again inside it and the multiplier climbs, up to 9x. Score is `merged value x combo`, so a fast chain of small merges beats one slow big one. Stall and it drops straight back to 1x. |
| **Charge & Vent** | Merging charges a meter. Full, it buys a Vent: the bottom row is blown out and the whole board drops one row — the exact inverse of a rise. It buys **space, not time**; the rise timer keeps running and the valve only re-arms on the next rise. |
| **Feeding** | Every successful move also drops one new tile into the lowest row with space, so there is always material to merge. |

The tuning is deliberate. Venting used to reset the rise timer, which made the
game unlosable — a fast player earns charge faster than the interval shrinks, so
they could stall the floor forever. Capping vents at one per rise fixed it.

## Two ways onto the page

There are two boards, and they do not touch.

**The paid board** is an auction with no losers and no door charge. Bidding
opens at **$0** and climbs from there: there is no entry fee to clear, only
whatever the people above you have already paid. Beat what the leader paid and
you take #1 — pay less and you simply seat lower, which is why a bid can never
be "rejected for being too small". The only amount that fails is one PayPal
cannot capture, so the real floor is a single cent. The claim form quotes the
rank your number would buy before you pay it, computed with the same `rankFor`
the board renders with.

**The earned slots** are the three slots beside the game, and they belong to the
three best runs. No bid moves them. One per player, so a single hot streak
cannot take the whole rail — only a player's best run counts and the rest of the
slots go to other people. If your run takes one, the optional link you attached
when posting the score is hung off it.

## Running it locally

```sh
npm install
npm run db:migrate:local     # create the local D1 tables (once)
npm run cf:dev               # game + API on http://localhost:8787
```

`npm run cf:dev` serves the built client, so run `npm run build` first (or use
`npm run dev` for the Vite dev server with hot reload, which proxies `/api` to
`localhost:8787` — run both together while iterating).

> On Windows, 8787 sometimes falls inside a reserved TCP exclusion range and
> `wrangler dev` dies with a `bind` permission error. Check with
> `netsh interface ipv4 show excludedportrange protocol=tcp` and pass
> `--port` something outside it.

```sh
npm test          # engine, replay and rules suites
npm run typecheck # client and worker, checked separately
npm run build
```

## Deploying to Cloudflare

The app is a single Worker with static assets and a D1 database. Nothing else.

```sh
# 1. Authenticate
npx wrangler login

# 2. Create the database, then paste the printed id into wrangler.toml
npx wrangler d1 create surge-db

# 3. Create the tables on the real database
npm run db:migrate

# 4. Build and ship
npm run cf:deploy
```

### PayPal

Without credentials the board is read-only — it renders, but nothing can be
claimed — and everything else works. To turn payments on:

```sh
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put PAYPAL_WEBHOOK_ID     # optional but recommended
```

`PAYPAL_ENVIRONMENT` in `wrangler.toml` is **`sandbox`**, and it stays that way
until you deliberately change it to `live`. Nothing about deploying to
production flips it — taking real money is its own decision, made on purpose.
Point a PayPal webhook at `https://<your-worker>/api/paypal/webhook` and
subscribe it to `PAYMENT.CAPTURE.COMPLETED`.

Secrets are never put in `wrangler.toml`; they would land in git.

## How a claim works

1. A visitor fills in a title, an optional description, an `https://` link, and
   any bid at all above $0.
2. The server validates it, creates a PayPal order, and stores the claim as
   `pending`. Nothing is displayed yet.
3. PayPal captures the payment. The server confirms the capture **server-side**
   and only then does the listing appear — at whatever rank the cleared amount
   earns it.

The amount that goes on the board is the amount PayPal says actually cleared,
never the number the browser asked for. Links are forced to `https`, rendered
with `rel="nofollow noopener sponsored"`, and opened in a new tab.

There is no longer a race to lose: in v1 a claim that cleared while someone else
was outbidding you was marked `outbid` and shown to nobody. Now it just lands
below them, which is both fairer and a good deal less code.

## Scores are verified, not trusted

There is no endpoint that accepts a score.

1. `POST /api/runs` issues `{ runId, seed }`. That seed drives every random
   choice in the run.
2. The client records each action as `(type, millisecond offset)`.
3. `POST /api/runs/:id/finish` submits the move log.
4. The server **replays the log against the seed it issued** and stores the score
   its own engine produces.

The engine reads no clock of its own and draws all randomness from a seeded RNG,
so a run is completely reproducible from `(seed, actions)`. Rises are rescheduled
from the moment they were *due* rather than the moment they were noticed, which
is what makes a 60 fps browser and a server replaying at move boundaries land on
byte-identical state.

Run tickets are single-use and expire after three hours, and logs that are out of
order, run past their stated duration, or exceed 20 000 actions are rejected.

This is not unbreakable — a good bot is still a good bot, and a determined forger
could synthesise a plausible log. What it does buy is that **a score can only be
claimed by producing a legal sequence of moves that actually earns it.** Editing
a number in a POST body does nothing.

## Agents are welcome

The game is playable programmatically, on purpose. `window.surge` is a
synchronous control API, and agent runs post to the same board as human runs
through the same verified replay.

```js
const s = window.surge;
s.getState();      // full board + run state
s.legalMoves();    // directions that would actually change something
s.move('down');
s.vent();
await s.waitForGameOver();
```

Full rules, the `GameState` schema and a worked bot example are in
[`public/agent.md`](public/agent.md), served at `/agent.md`, with
[`/llms.txt`](public/llms.txt) as the machine-readable index.

Bots will out-score humans — they merge far faster, and the combo multiplier
rewards exactly that. That is a consequence of inviting them, not a defect. It
also means the earned slots are, in practice, contested by bots.

## Layout

```
index.html            page shell
wrangler.toml         Worker, assets and D1 bindings
migrations/           D1 schema (0002 turns the single banner into a board)
src/
  main.ts             run lifecycle, input, frame loop
  styles.css          the light shell around a dark board
  game/engine.ts      all the rules — no DOM, injected time, seeded RNG
  game/rng.ts         deterministic mulberry32
  render/renderer.ts  canvas: tweening, particles, shake, pressure bar
  render/palette.ts   every colour the board paints, tiles derived from exponent
  ui/                 tutorial, leaderboard, board + PayPal, agent API
  net/api.ts          worker client
shared/
  replay.ts           action log encoding + authoritative replay
  rules.ts            validation, pricing and ranking, used by both sides
worker/
  index.ts            Hono app: scores, board, webhook
  paypal.ts           Orders v2 + webhook signature verification
test/                 vitest suites
```

`src/game/engine.ts` holds every rule and touches no DOM, which is what lets the
same file run the browser at 60 fps and settle leaderboard disputes inside a
Worker. `shared/rules.ts` plays the same role for money: the price the browser
quotes and the price the Worker enforces come from one file.

## Accessibility and browser support

The page is a fresh mint-white shell and the board is light to match — the tile
ramp walks from pale green through citrus into coral and pink, so a bigger tile
reads as hotter, and every colour the board paints lives in
`src/render/palette.ts` rather than scattered through the draw calls.
A run pauses while its tab is hidden. `requestAnimationFrame` stops when you
switch away, so without discounting that time every rise that fell due while you
were gone would land in the first frame back and bury you before you could move.
The action log is timed off the same paused clock, so the server replay still
agrees with what the player saw.

`prefers-reduced-motion` disables tweening,
particles and shake, and snaps tiles into place instead. Keyboard play is full
(arrows, WASD, HJKL, Space to vent) and typing in any input never moves the
board. Player-supplied text is always rendered through `textContent`, never
`innerHTML`.
