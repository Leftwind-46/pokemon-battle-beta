---
name: pvp-networking
description: Use when working on the WebSocket protocol, room/connection management, server-authoritative state sync between server.js and public/pvp.html, or Zeabur deployment. Triggers on requests like "連線問題", "房間", "斷線", "WebSocket", "訊息協議", "伺服器", "部署", "reroll按鈕", "同步".
---

# PvP Networking (連線相關)

## Architecture: server-authoritative, thin client

`server.js` (Node + `ws` WebSocket + Express) owns **all** game state (`room.G`) and **all** randomness. `public/pvp.html` never computes outcomes locally — it sends an intent message, waits for the server's broadcast, and re-renders from whatever state arrives. If you're ever tempted to have the client predict/compute a result (even just for a snappier UI), don't — every prior instance of client-side prediction in this codebase was later revealed to be wrong or exploitable. The one narrow exception: the client locks its own UI (`G.busy = true`) optimistically right after sending a message, purely to prevent double-sends before the server's reply arrives — it doesn't compute or display any *result*.

## Room lifecycle

`rooms` (in-memory `Map`, no persistence — a server restart drops all active games). Room object: `{code, p1, p2 (ws refs), phase: 'waiting'|'selecting'|'battle'|'done', p1Roster/p2Roster, p1Team/p2Team, p1Ready/p2Ready, p1Rerolls/p2Rerolls, coinFlip, G}`. `ws.on('close', ...)` deletes the room outright if `phase !== 'done'` — **any** disconnect during team-select deletes the room, even a brief network blip, which is why reroll/other messages sent right after a disconnect must fail gracefully (`send(ws, {type:'error',...})`) instead of the old silent `return` that left the client hanging forever (fixed 2026-07-01).

## Message protocol (client → server)

`create_room`, `join_room`, `reroll`, `select_team`, `attack`, `standby`, `switch`, `ko_switch`, `use_trainer`, `discard`, `discard_trade`, `chat`. All routed through one `handleMessage(ws, msg)` function, one big `if (type === '...')` chain (not a lookup table — grep the literal string when hunting for a handler). Every handler that can fail validation should `send(ws, {type:'error', message:...})` rather than silently `return`ing — a silent return with no reply is indistinguishable, from the client's perspective, from a dropped packet, and the client has no generic timeout/retry, so it just hangs (this exact bug caused the "重新生成按鈕偶爾沒反應" report, fixed 2026-07-01).

Server → client: `room_created`, `joined`, `opponent_joined`, `opponent_ready`, `roster_update`, `battle_start`, `update` (the workhorse — sent after nearly every action, carries `{state: G, log: [...], actor, atkType?}`), `game_over`, `error`, `opponent_disconnected`, `chat`.

## Client state sync

`public/pvp.html`'s `applyServerState(sG)` is the single place server state gets copied into the client's local `G` — it remaps role-based server fields (`p1Deck`/`p2Deck`) into perspective-based client fields (`playerDeck`/`cpuDeck`) using `myRole`. If you add a new field to the server's `G` object that the client needs to display, it must be added to `applyServerState` too, or it'll silently never reach the UI. `G.busy` is *derived* here (`turn !== me` or an opponent-pending-KO-switch), not sent directly — don't add a redundant server-sent `busy` field.

## Known fragile spots

- **Reroll button**: fixed 2026-07-01 (see above) — if similar "button seems unresponsive" reports come in for other actions, check for the same silent-`return`-on-invalid-state pattern first before assuming it's a rendering bug.
- **`pendingKOSwitch` is single-valued** (`null | 'p1' | 'p2'`) but some effects (搏命, and the double-KO fix) need *both* sides to sequentially replace — handled via `G.pendingKOSwitchQueue`, drained one at a time inside the `ko_switch` handler. If you add another effect that can KO both sides at once, reuse this queue rather than inventing a second one.
- **Turn-ownership — FIXED 2026-07-08, this note previously described the bug, not current behavior.** When an attacker dies from their *own* status/reflect damage before their attack lands (`sResult.died` in the `attack` handler), `G.turn` used to be left unchanged, letting that player act again immediately after replacing their fainted mon. Both the `sResult.died` branch and the sibling reflect-death branch now explicitly set `G.turn = op; G.round++; drawForRole(G, op);`, matching every other KO path. See battle-logic skill's KO/double-KO section for the full fix writeup — if you find a *third* "attacker dies without the defender dying" branch anywhere, verify it sets `G.turn = op` too, this omission has already recurred once.
- Every WS handler should stay wrapped so one bad message can't crash the whole process and disconnect both players — keep new handlers inside the existing try/catch scope in `wss.on('connection', ...)`.

## Deployment (Zeabur)

`server.js` via `npm start`; `PORT` auto-injected. PostgreSQL auto-injects `POSTGRES_*` env vars when in the same Zeabur project — **do not manually set `DATABASE_URL`**, a prior attempt to do so broke the Docker build (space-containing connection string). No DB tables are actually required for gameplay (`rooms` is in-memory); the `pool` connection is best-effort and the server logs "No DB configured, running in-memory only" and continues fine without it — useful to know when testing locally with `node server.js` and no Postgres available.

## Accounts / persistence (2026-07-10)

Login is **purely additive**, never a gate on PvP. `wss.on('connection', (ws, req) => {...})` parses an optional `?token=` query param; a valid token sets `ws.userId`/`ws.username`, an invalid/missing token or absent `pool` just leaves them `undefined` and the connection proceeds exactly like today's anonymous flow — **never reject a WS connection over auth**. Token verification is async (`pool.query`), so incoming messages are queued (`msgQueue`/`authPending` in the connection handler) until it resolves, so a fast first message right after connecting isn't dropped.

3 Postgres tables (`users`, `teams`, `weekly_stats`), all `CREATE TABLE IF NOT EXISTS` in `initDB()` — never `DROP`/destructive `ALTER`, this data must survive every deploy. `teams.pokemon_ids` is a persistent 6-Pokémon pool per account (not a fixed 3-team) — every match still goes through the ordinary `select_team` (pick 3-of-6) flow unchanged, so this required zero changes to `battle_start` triggering logic. `randomRoster(6, 300, 1)` (the same helper anonymous players use) is wrapped by `generatePlayerPool()` for all three places a 6-pool gets generated: registration, `edit_team` candidates, and stale-id auto-repair (`loadUserTeam()`/inline repair in `create_room`/`join_room`) — **the `hpCap=300, maxAtCap=1` params are a deliberate balance rule the user asked for, not a default to tweak casually**.

Roster source in `create_room`/`join_room`: `getRosterForConnection(ws)` — if `ws.userId && pool`, reads the account pool (with auto-repair); otherwise (anonymous, no DB, or a DB error) falls back to the exact same `randomRoster()` call anonymous players have always used. Any DB failure here degrades to the anonymous path rather than erroring the room.

Logged-in players get an "編輯隊伍" button in team-select (replacing, not alongside, the anonymous "重新生成" button) — `edit_team` WS message generates 6 fresh candidates (costs 1 of 3 uses immediately, whether or not anything gets swapped, same cost model as reroll), `confirm_team_edit` applies validated `{slotIdx, candidatePokemonId}` pairs to both the in-room roster and `teams` (permanent). Server never trusts client-supplied candidate ids — validates against the most recently generated batch.

`game_over` is broadcast from a single place now: `endGame(room, winner, log, extra={})`, which all 11 former call sites route through. It sets `G.winner`/broadcasts/`room.phase='done'` synchronously, then fires `recordWeeklyStats()` async (never blocks or risks the broadcast) — upserts `weekly_stats` only for sides with a `userId`; a draw or two-anonymous match writes nothing. Week bucketing is `mondayOfWeek(date)`, no cron — a new week's row just gets created lazily on the first win that lands in it. **If you ever add a 12th path that can end a game, route it through `endGame()`, not a fresh `broadcast(room, {type:'game_over',...})`** — this is the same "grep every sibling call site" discipline as `adding-cards`, just applied to `game_over` instead of `TRAINERS`.

GM admin: `users.is_admin`/`disabled` columns, no self-registration — **to make an account an admin, connect to Postgres directly and run `UPDATE users SET is_admin = true WHERE username = '...';`** (no UI for this, intentionally — see `project_pokemon_battle.md` memory for the exact recommended command). `requireAdmin` middleware layers on `requireAuth`, guards `/api/admin/*`; `public/admin.html` is a fully separate static page reusing the same `/api/login`+`/api/me`-adjacent auth (it actually confirms admin status via a 403 from `GET /api/admin/users` rather than a dedicated `isAdmin` field, since `/api/me` doesn't expose that field).

**Testing without a real Postgres**: none of this was ever end-to-end verified against a live DB (this dev machine has neither Docker nor a local Postgres install) — only verified via (a) extraction tests that `new Function()`-eval relevant functions out of `server.js` text with a mocked `pool.query`, see `stage1_extract_test.js`/`stage6_endgame_test.js` pattern, and (b) confirming every DB-touching endpoint degrades to a graceful `503 {error:'no_db'}` rather than crashing when `pool` is null. Before trusting this in production, run the full register→login→create_room→battle→game_over→leaderboard loop against a real (local/throwaway, never prod) Postgres at least once.
