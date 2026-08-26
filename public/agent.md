# SURGE — agent guide

Everything an automated player needs: the rules, the state schema, the control
API, and how scoring actually works. If you are a human, the in-page tutorial
("How to play") covers the same ground more gently.

Machine-readable index: [/llms.txt](/llms.txt)

---

## The game in one paragraph

A 5x5 well. You slide the whole board in one of four directions; tiles travel as
far as they can and equal tiles merge into their sum. Unlike 2048 the board is
under time pressure: rows push in from the **bottom** on a timer and shove
everything **up**, and any tile still in the **top row** when a row rises is
crushed, ending the run. There is no winning tile — you play for score.

## Rules that differ from 2048

| | Surge |
|---|---|
| Board | 5 columns x 5 rows. Row 0 is the **top** and is the danger row. |
| Merging | Equal tiles double. A tile can merge only once per move, so `2 2 2 2` → `4 4`. |
| Rising | Every `riseInterval` ms, 2–4 tiles enter along the bottom and every row shifts up one. |
| Feeding | Every successful move also drops one new tile (usually a 2) into the lowest row with space, so there is always material to merge. |
| Losing | A rise while any tile occupies row 0. That is the only loss condition. |
| Scoring | `sum(merged values) x combo`, where `combo` is the multiplier **before** this move. |
| Combo | Starts at 1. Each merge sets a 2600 ms window and raises the combo by the number of merges in that move, capped at 9. Let the window lapse and it drops straight back to 1. |
| Charge | Each merge adds `log2(mergedValue)`, capped at 20. |
| Vent | At full charge **and** with the valve armed, blows out the bottom row and shifts every row **down** one. Costs the whole meter. It does **not** touch the rise timer, and the valve only re-arms on the next rise — so at most one vent per rise cycle. |
| Level | `floor(merges / 12)`. Each level multiplies the rise interval by 0.92, floored at 2600 ms. |

### What this means strategically

- **Speed beats size.** A merged 8 at combo 5 scores 40; a merged 64 at combo 1
  scores 64, but four quick small merges would have banked more and kept the
  multiplier alive. Chain merges.
- **Sliding `up` is how you die.** It packs tiles into row 0, and the next rise
  crushes them. Prefer `down`, and use `up` only to line up a merge you will
  immediately collapse.
- **Vent early enough to matter.** It buys space, never time, so saving it for
  the last second does not rescue you — the rise still lands. And since the
  valve re-arms only on a rise, a held meter is charge you are not spending.
- **Time passes even when you do not move.** Thinking has a cost — the rise
  timer runs regardless.

---

## Control API

Loaded on the page as `window.surge`. Synchronous, and identical to what the
keyboard drives, so runs made this way are ordinary runs and post to the
leaderboard through the same verified replay.

```js
const s = window.surge;

s.getState();          // → GameState (below)
s.move('left');        // 'up' | 'right' | 'down' | 'left' → GameState after the move
s.up(); s.down(); s.left(); s.right();   // shorthands
s.vent();              // spends a full meter; no-op when state.canVent is false
s.newGame();           // abandons the run and starts a fresh one
s.legalMoves();        // → directions that would actually change the board
s.subscribe(fn);       // fn(state) on every change; returns an unsubscribe fn
await s.waitForGameOver();   // resolves with the final state
s.docs;                // this document, as text
```

`move()` throws a `TypeError` on an unknown direction. A move that changes
nothing is not an error — it simply returns the unchanged state, which is why
`legalMoves()` is worth consulting.

### GameState

```ts
{
  status: 'idle' | 'playing' | 'over',
  cols: 5,
  rows: 5,
  grid: number[][],      // row-major, grid[0] is the TOP row, 0 = empty cell
  tiles: Tile[],         // {id, value, row, col, ...} — same data, per tile
  score: number,
  combo: number,         // current multiplier, 1..9
  comboRemaining: number,// 1 → 0, fraction of the combo window left
  charge: number,        // 0..20
  chargeMax: 20,
  canVent: boolean,      // charge is full, valve armed, run live
  ventArmed: boolean,    // false until the next rise re-arms it
  level: number,
  merges: number,
  moves: number,
  risePressure: number,  // 0 → 1, how close the next rise is
  msToRise: number,      // milliseconds until it fires
  elapsedMs: number,
  bestTile: number,
  seed: number
}
```

### A minimal bot

```js
const s = window.surge;

// Prefer down/left/right; only slide up when nothing else moves.
const preference = ['down', 'left', 'right', 'up'];

while (s.getState().status === 'playing') {
  const state = s.getState();
  if (state.canVent && state.risePressure > 0.6) { s.vent(); continue; }

  const legal = s.legalMoves();
  const pick = preference.find((d) => legal.includes(d));
  if (!pick) break;
  s.move(pick);

  await new Promise((r) => setTimeout(r, 50)); // let the renderer breathe
}

console.log('final score', s.getState().score);
```

A stronger agent should search a move or two ahead, weight keeping row 0 empty
very highly, and treat the combo window as a resource that decays.

---

## Scoring is verified server-side

Do not try to POST a score — there is no endpoint that accepts one.

1. `POST /api/runs` issues `{ runId, seed }`. The seed drives every random
   choice in the run.
2. You play. The client records each action as `(type, millisecond offset)`.
3. `POST /api/runs/:runId/finish` sends `{ name, log, durationMs }` where `log`
   is the encoded action list.
4. The server replays that log against the seed it issued and stores **the
   score its own engine produces**. The reply includes `verifiedScore`.

The log format is an uppercase action code followed by a lowercase base-36
millisecond delta from the previous action: `U` up, `R` right, `D` down, `L`
left, `V` vent. So `D0R5aVm2` is: down at 0 ms, right 190 ms later, vent 796 ms
after that.

Consequences worth knowing:

- A run ticket is single-use and expires after 3 hours.
- An action log that is out of order, runs past `durationMs`, or exceeds 20000
  actions is rejected outright.
- Because time is part of the log, a run that "plays" 5000 moves in 3 seconds
  replays as 5000 moves in 3 seconds — the rises fire accordingly and the board
  buries you exactly as it would have live. Fast is not free.

## Public endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/scores?limit=25` | Top scores best first, plus the three-place podium. |
| `POST` | `/api/runs` | Open a run, receive `{ runId, seed }`. |
| `POST` | `/api/runs/:id/finish` | Submit `{ name, log, durationMs }`. |
| `GET` | `/api/health` | Liveness. |

The **podium** beside the game holds the three best runs, one place per player,
so a single hot streak cannot take all three. A bot that scores well takes a
place the same way a human does.
