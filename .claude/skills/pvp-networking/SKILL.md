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
- **Turn-ownership quirk**: when an attacker dies from their *own* status damage before their attack lands (`sResult.died` in the `attack` handler), `G.turn` is deliberately left unchanged (pre-existing behavior, not something introduced recently) — meaning that player effectively gets to try attacking again immediately after replacing their fainted mon. This is inconsistent with every other KO path (which correctly hands the turn to the other side) but has been left alone across multiple sessions as an existing quirk rather than risk a turn-order regression fixing it unprompted — flag it to the user before "fixing" it.
- Every WS handler should stay wrapped so one bad message can't crash the whole process and disconnect both players — keep new handlers inside the existing try/catch scope in `wss.on('connection', ...)`.

## Deployment (Zeabur)

`server.js` via `npm start`; `PORT` auto-injected. PostgreSQL auto-injects `POSTGRES_*` env vars when in the same Zeabur project — **do not manually set `DATABASE_URL`**, a prior attempt to do so broke the Docker build (space-containing connection string). No DB tables are actually required for gameplay (`rooms` is in-memory); the `pool` connection is best-effort and the server logs "No DB configured, running in-memory only" and continues fine without it — useful to know when testing locally with `node server.js` and no Postgres available.
