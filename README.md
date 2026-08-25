# 2048

The sliding tile game, with a leaderboard for finished runs.

Slide the tiles with the arrow keys (or `WASD`, or a swipe). Two tiles with the
same number merge into their sum, and the run ends when the board is full and
nothing can move. Reach 2048 to win — then keep going for a bigger tile.

No build step and no dependencies: plain ES modules, one Node file for the
server, and Node's own test runner.

## Running it

```sh
npm start          # http://127.0.0.1:8080
```

`PORT` and `HOST` override where it listens, and `DATA_DIR` overrides where
leaderboard scores are written (`./data` by default).

The page needs to be served over HTTP rather than opened straight from disk —
browsers block ES modules on `file://` URLs. Any static server works if you
would rather not run this one; see [The leaderboard](#the-leaderboard) for what
changes when there is no API behind it.

## Tests

```sh
npm test
```

Covers the game rules (sliding, merging, spawning, win and game-over
detection, save/restore), the leaderboard rules shared by both sides, the
client's server/local fallback, and the HTTP API including validation, path
traversal and concurrent writes.

## The leaderboard

Finished runs are recorded with a name, score, best tile, move count and
duration. The board shows the top ten.

The client prefers the server API so everyone playing against the same host
shares one board. If there is no API — the files are on a static host, or the
server is down — it falls back to a private board in `localStorage` and says so
in the panel header (`Shared` vs `This browser`). A run is never lost to a
missing server; it just lands in the local board instead.

A submission the server actively *rejects* (a malformed or out-of-range run) is
reported to the player rather than quietly stored locally.

### API

| Method | Path                      | Purpose                                  |
| ------ | ------------------------- | ---------------------------------------- |
| `GET`  | `/api/scores?limit=10`    | Top scores, best first.                  |
| `POST` | `/api/scores`             | Submit a finished run.                   |

`POST` body:

```json
{ "name": "Ada", "score": 12345, "bestTile": 1024, "moves": 812, "durationMs": 600000 }
```

The server assigns `id` and `createdAt` — a client cannot set them. `name` is
trimmed and capped at 16 characters, `score` and `moves` must be non-negative
integers, and `bestTile` must be a power of two. Anything else is a `400` with
a reason. The response carries the accepted `entry`, its `rank` (or `null` if
it missed the cut) and the refreshed top ten.

Scores are stored as JSON in `DATA_DIR/leaderboard.json`, written atomically
and serialised so simultaneous submissions cannot clobber one another. Nothing
authenticates a submission, so treat the board as a friendly scoreboard rather
than a contested ranking.

## Layout

```
index.html        markup
styles.css        styles, light and dark
server.js         static files + leaderboard API
src/game.js       game rules — no DOM, injectable randomness
src/scores.js     leaderboard validation and ranking, shared with the server
src/leaderboard.js client: server API with a localStorage fallback
src/storage.js    localStorage that cannot throw
src/main.js       rendering and input
test/             node --test suites
```

`src/game.js` holds every rule and touches no DOM, so it can be tested
directly; `createSeededRandom` makes a run reproducible. `src/main.js` only
draws what the engine reports and animates moves from the `previous` position
and `mergedFrom` links each move returns.

Your game in progress, your best score and your name are kept in
`localStorage`, so a reload picks up where you left off.
