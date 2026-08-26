# SURGE

A tile-merging arcade game where the floor keeps rising, wrapped in a pastel
shell that comes in light and dark.

Slide a 5x5 board and merge equal tiles. Unlike 2048, the board is under
constant pressure: rows push in from the bottom on a timer that tightens as you
level, and anything left in the **top row** when a row rises is crushed. There
is no winning tile — you play for score until the board buries you.

Playing is free, there is nothing to buy, and the only way onto the board is a
score the server replayed for itself.

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

## The board and the podium

There is one leaderboard, it is free, and every row on it was produced by the
server replaying a real move log.

Beside the game sits the **podium**: the three best runs, one place per player,
so a single hot streak cannot take all three. It is fed from the same response
the table renders, so posting a run updates both without a second round trip.

## Look and theme

The page and the game share one pastel palette in two themes.

Every colour the shell paints is a custom property on `:root` in
`src/styles.css`, and dark mode redefines the tokens rather than restyling
components — a rule written once is correct in both themes. `data-theme` on
`<html>` is the switch: a blocking inline script in `index.html` applies the
stored choice before first paint so a dark-mode visitor never sees a white
flash, and `src/ui/theme.ts` owns it from there.

The canvas cannot read CSS variables, so the board keeps its own copy of the
palette in `src/render/palette.ts` and the theme controller swaps it at the same
moment. Tile hue is derived from the exponent rather than picked off a list, so
a 65536 tile is a natural continuation of a 2. The ramp climbs from sky blue
through periwinkle, orchid and rose into peach — routed around the yellow-green
stretch, which is the one part of the wheel that does not survive being made
pastel. Tiles stay pale in both themes, so one dark ink is readable on every
step of the ramp.

A visitor who has never touched the toggle follows their system setting and
keeps following it. The moment they pick a side it is stored, and system changes
stop moving the page under them.

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
  styles.css          pastel tokens, light and dark
  game/engine.ts      all the rules — no DOM, injected time, seeded RNG
  game/rng.ts         deterministic mulberry32
  render/renderer.ts  canvas: tweening, particles, shake, pressure bar
  render/palette.ts   every colour the board paints, in both themes
  ui/                 tutorial, leaderboard, podium, theme, agent API
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

`prefers-reduced-motion` disables tweening, particles and shake, and snaps tiles
into place instead. `prefers-color-scheme` picks the theme for anyone who has
not chosen one. Keyboard play is full (arrows, WASD, HJKL, Space to vent) and
typing in any input never moves the board. Player-supplied text is always
rendered through `textContent`, never `innerHTML`.
