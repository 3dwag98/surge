# SURGE

A tile-merging arcade game where the floor keeps rising, in a risograph shell
that comes in light and dark. It opens playing itself.

Slide a 5x5 board and merge equal tiles. The board is under constant pressure:
rows push in from the bottom on a timer that tightens as you level, and anything
left in the **top row** when a row rises is crushed. There is no winning tile —
you play for score until the board buries you.

Playing is free, there is nothing to buy, and the only way onto the board is a
score the server replayed for itself.

---

## The four systems

SURGE is its own game, described on its own terms: a merge game played under
constant pressure, not a variation on anything else.


| Mechanic | What it does |
|---|---|
| **Rising floor** | Every few seconds a partial row shoves in from below and everything moves up one. The interval shrinks with every level. Being caught in the top row is the only way to lose. |
| **Combo window** | Each merge opens a 2.6 s window. Merge again inside it and the multiplier climbs, up to 9x. Score is `merged value x combo`, so a fast chain of small merges beats one slow big one. Stall and it drops straight back to 1x. |
| **Charge & Vent** | Merging charges a meter. Full, it buys a Vent: the bottom row is blown out and the whole board drops one row — the exact inverse of a rise. It buys **space, not time**; the rise timer keeps running and the valve only re-arms on the next rise. |
| **Overcharge** | Keep merging instead of spending a full meter and it overcharges at 2x into a **Surge**, worth two rows instead of one. This is the decision the meter was missing: holding it is a bet, buying twice the room at the price of playing on with no valve while the floor climbs. A Surge is still one vent — it does not re-arm anything. |
| **Feeding** | Every successful move also drops one new tile into the lowest row with space, so there is always material to merge. |

The tuning is deliberate. Venting used to reset the rise timer, which made the
game unlosable — a fast player earns charge faster than the interval shrinks, so
they could stall the floor forever. Capping vents at one per rise fixed it.

## The board and the podium

There is one leaderboard, it is free, and every row on it was produced by the
server replaying a real move log.

Beside the game sits the **podium**: the three best runs, one place per player,
so a single hot streak cannot take all three. It is fed from the same response
the table renders, so posting a run updates both without a second round trip.

## Attract mode

The page opens playing itself.

An arcade cabinet does not sit on a title card — it plays until somebody puts a
coin in — and for this game that is the honest thing to do rather than a
flourish: `window.surge` exists so bots can play, so a bot demonstrating the
game *is* the product. The demo runs on the real engine and the real renderer,
but never on a server ticket, so a visitor who only watches costs no run and can
post no score, and the demo cannot touch your personal best. The first key,
click, touch or agent call claims the cabinet and opens a real run.

`prefers-reduced-motion` gets no demo at all: the board is dealt and held still,
with the same prompt over it. `src/ui/attract.ts` owns the loop; `src/main.ts`
owns the three states a board can be in — `idle`, `attract`, `live` — and only a
live run touches the action log, the personal best or the server.

## Look and theme

The direction is *candy shell, brutal machine*: the surface is soft, the game is
not.

**Colour is risograph.** A riso print makes a new colour by overprinting two
inks, which is the move the game makes when two tiles fuse — so the tiles are
inks and the ramp walks the ink drawer rather than a smooth colour wheel: aqua,
blue, indigo, violet, orchid, fluorescent pink, red, orange, yellow. Hue is
still derived from the exponent, so a 65536 tile is a natural continuation of a
2. Two of those inks carry meaning rather than taste, and they mean the same
thing everywhere they appear, page and board alike: **aqua is room, fluorescent
pink is something about to happen to you.** A fine fixed grain over the page is
the paper.

**Type is compressed**, because the game is about being squeezed against a
ceiling. The display face is Archivo on its width axis, and the masthead's
second line is set narrower than its first. Body copy is Figtree; every number,
label and key is DM Mono, because scores are data. The type scale doubles and is
named for the tile it doubles like — `--t2` through `--t64`.

**Nothing is in a box.** A riso print is flat areas of ink, not hairline frames,
so there are no cards, no panels and no frame around the board — structure comes
from washes, weight and space. A section is a mono label with room under it, a
control is a filled shape, and the whole page keeps exactly two rules: under the
masthead and under the scores heading, both on the same measure. That puts the
weight on alignment, so the board is drawn flush to its own edges — gaps sit
between cells, never around them — and its left edge lines up with the HUD above
it and the rule above that.

Losing the frame cost the board two things, both replaced rather than dropped. A
climbing combo used to be drawn as a rectangle around the well; it now warms the
empty cells instead, and deliberately skips the top row, because at a high combo
the tint is nearly the same ink as the danger wash and would erase the one band
the player has to keep reading.

**Structure encodes the content.** The four mechanics are not steps, so they are
not numbered 01/02/03; each is labelled with the engine constant that governs it
(`9.0s → 2.6s`, `Row 1`, `2.6s · 9× cap`, `1 per rise`). The high score table
*is* ranked, so there rank is set like a result. The page has one measure —
`--measure` in `src/styles.css` — so the masthead rule, the board, the scores
rule and the colophon all begin and end together.

## The two meters, and the vent

The board is bracketed by its two clocks, each drawn on the edge it is about.
The **rise timer** runs along the ceiling, directly above the row that kills you,
because that is what it is counting down to. The **charge meter** runs along the
floor, because a vent blows the floor out.

The vent needs saying plainly, because it has three states and they used to look
like two. Charge fills as you merge, but the valve only re-arms on the next
rise — so a fast player can refill a full meter and still be locked out. A full
bar over a dead button is what makes a control read as broken, so the button now
names the state it is actually in: `Charging 60%`, `Vent ready at the next rise`,
`Vent · 70% to Surge`, or `Surge · two rows` in the alarm ink. The key hint only
appears when pressing it will do something, and the canvas meter grows a second
stretch above the first for the overcharge.

The one deliberate imprecision is the wordmark: three ink plates a hair out of
register, multiplied in light and screened in dark.

Everything else is tokens. Dark mode redefines them rather than restyling
components, so a rule written once is correct in both. `data-theme` on `<html>`
is the switch: a blocking inline script in `index.html` applies the stored
choice before first paint so a dark-mode visitor never sees a white flash, and
`src/ui/theme.ts` owns it after that. The canvas cannot read CSS variables, so
`src/render/palette.ts` keeps its own copy and is swapped at the same moment. A
visitor who has never touched the toggle follows their system setting and keeps
following it; the moment they pick a side it is stored.

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

The app is a single Worker with static assets and a D1 database. Nothing else —
no payment provider, no secrets to set.

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

### Analytics

Cloudflare Web Analytics is optional and off until you give it a token. Create a
site under **Analytics & Logs → Web Analytics → Add a site**, then paste the site
token into `WEB_ANALYTICS_TOKEN` in `wrangler.toml`. It is a public identifier
rather than a secret — it ships in the page of every visitor — so it belongs in
the config file, not in `wrangler secret`. `GET /api/health` reports whether a
token is configured, which is the quickest way to tell whether a deployment is
being measured.

The beacon is appended by the Worker rather than baked into `index.html`, so a
deployment with no token serves the page untouched and there is no placeholder
to forget about. It sets no cookies and collects nothing that needs a consent
banner.

That injection is the reason for `run_worker_first` in `wrangler.toml`. Static
assets are normally served before the Worker ever runs, which is what you want
for JS, CSS and fonts — but it means the HTML document never reaches the Worker
either. **That list is exhaustive: any path left off it is handed to the SPA
fallback and never sees the Worker.** `/api/*` has to be on it or the entire API
starts answering with `index.html`.

## What happens under load

The whole thing runs on Cloudflare's free tier, which is a real ceiling rather
than a theoretical one: 100,000 Worker requests a day, and a daily row allowance
on D1. A single script can spend either of those in minutes. Three things keep
that from being a silent failure.

**Rate limits — a speed bump, not a wall.** Two `ratelimits` bindings in
`wrangler.toml`, 60 reads and 20 writes a minute, keyed on the caller's IP. Over
budget gets `429` with a `Retry-After`.

Be clear about what this does buy, because it is less than it looks. The
binding is [documented ↗](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
as "permissive, eventually consistent, and intentionally designed to not be used
as an accurate accounting system", with counters cached per machine and updated
asynchronously. In practice that is not a figure of speech: `wrangler dev`
simulates it exactly — 20 writes pass, the 21st is refused — while against the
deployed Worker 160 requests from one IP over 100 seconds were all allowed,
because they spread across machines that each saw a small count. It blunts a
sustained single-source flood. It will not stop a burst, and nothing on
workers.dev will; that needs WAF rate limiting rules, which need a custom
domain.

It still earns its place: it costs nothing, and it replaced a `COUNT` over the
`runs` table, which answered a flood of run requests by hammering the database
it was supposed to protect — spending the D1 allowance it was defending.

**The client does not join in.** A client that retries through a rate limit is
part of the storm. When the server answers `429` or `503` it also says how long
to wait, and until that passes new runs start locally without touching the
network at all.

**Honest errors when the database runs out.** A D1 failure is not a bug in this
Worker, and answering it with `internal error` tells a player nothing they can
act on. `app.onError` tells the two useful cases apart and returns `503` for
both: out of daily allowance, which fixes itself at the reset and means nobody
can post today, and unreachable, which is worth retrying now. `GET
/api/health?db=1` runs one query and reports `ok`, `over-limit` or
`unavailable` — opt-in, because a monitor polling it every minute would spend
the allowance it is watching.

**This is not theoretical.** The D1 path was exercised in production while
testing this: under a burst, one request came back
`D1_ERROR: internal error`, and the handler answered it as a retryable `503`
rather than `internal error`. That is the whole point of the split.

**The game keeps working regardless.** None of this stops play: the engine needs
no network, and a run without a server ticket is still a run. What changes is
that the player is told *at the start* rather than after five good minutes — a
line under the deck naming the actual reason, in the server's own words, and the
same reason again on the game-over card. The board's status line does the same
for the leaderboard.

The one case the Worker cannot answer for itself is running out of Worker
requests: past the daily limit Cloudflare responds before the Worker does, with
an error page rather than JSON. The client treats a non-JSON reply as exactly
that and says so, instead of reporting a malformed response.

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
also means the podium is, in practice, contested by bots.

## Layout

```
index.html            page shell + the pre-paint theme script
wrangler.toml         Worker, assets and D1 bindings
migrations/           D1 schema (0003 drops the retired paid board)
src/
  main.ts             run lifecycle, input, frame loop
  styles.css          riso tokens, one shared measure, no boxes, light and dark
  game/engine.ts      all the rules — no DOM, injected time, seeded RNG
  game/rng.ts         deterministic mulberry32
  render/renderer.ts  canvas: tweening, particles, shake, the two meters
  render/palette.ts   the ink drawer: every colour the board paints, both themes
  ui/                 attract, tutorial + diagrams, leaderboard, podium, theme, agent API
  net/api.ts          worker client
shared/
  replay.ts           action log encoding + authoritative replay
  rules.ts            names, score ordering and the podium, used by both sides
worker/
  index.ts            Hono app: runs and scores
test/                 vitest suites
```

`src/game/engine.ts` holds every rule and touches no DOM, which is what lets the
same file run the browser at 60 fps and settle leaderboard disputes inside a
Worker. `shared/rules.ts` plays the same role for ordering: the rank the browser
renders and the rank the Worker computes come from one file.

## Accessibility and browser support

A run pauses while its tab is hidden. `requestAnimationFrame` stops when you
switch away, so without discounting that time every rise that fell due while you
were gone would land in the first frame back and bury you before you could move.
The action log is timed off the same paused clock, so the server replay still
agrees with what the player saw.

`prefers-reduced-motion` disables tweening, particles and shake, snaps tiles into
place, and turns off attract mode entirely — the board is dealt and held still
rather than playing itself. `prefers-color-scheme` picks the theme for anyone
who has not chosen one. Keyboard play is full (arrows, WASD, HJKL, Space to vent) and
typing in any input never moves the board. Player-supplied text is always
rendered through `textContent`, never `innerHTML`.
