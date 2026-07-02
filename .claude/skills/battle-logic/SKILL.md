---
name: battle-logic
description: Use when working on turn flow, attacks/damage calculation, trainer cards (道具牌/支援者牌/競技場牌), status effects (中毒/燒傷/麻痺/睡眠/結凍/混亂), KO/double-KO resolution, buffs (atkBonus/atkMult/shield/reflect/typeOverride), or ability trigger hooks. Triggers on requests like "新增卡片", "修改攻擊力計算", "狀態異常有問題", "換場機制", "反彈鏡", "同時陣亡判定", "特性觸發".
---

# Battle Logic (對戰相關)

## Core rule: fix single-player AND PvP together

Every battle mechanic exists **twice**, independently implemented: `pokemon_battle.html`/`public/single.html` (client-only, CPU opponent) and `server.js` (server-authoritative) + `public/pvp.html` (thin render client). They are NOT sharing code. A fix in one almost never automatically applies to the other — treat every battle-logic change as two separate patches that happen to be conceptually identical. This has been the single most common source of "works in single-player but not PvP" bugs across every session so far.

After editing `pokemon_battle.html`, sync: `cp pokemon_battle.html public/single.html && diff` to confirm.

## Turn flow (single-player)

```
playerAttack(i) / playerSwitch(i) / playerStandby()
  └─ doAttack(player→cpu) → cpuAttack()
       └─ cpuUseTrainers()  [CPU plays trainer cards from hand first]
          └─ doAttack(cpu→player)
               └─ handleKO(side, cb) if HP ≤ 0
                    └─ showResult() if that side's whole team is wiped, else cb()
```
`G.busy=true` disables player input during animations/CPU turn; resets via the various `endTurn`-style callbacks.

Switching (`playerSwitch` → confirm modal → `executeSwitch`) **ends the turn** by default (×0.8 damage guard applied to the switched-in mon, `G.playerSwitchGuard`) — except when `G.freeSwitch` is set (granted by the 撤退背心/retreat-vest item card), in which case it skips the confirm modal and does NOT end the turn. `G.freeSwitch` was a previously-dead unused field from an older design (换人命令 card) — repurposed rather than adding a new one; if you see other suspiciously-unused `G.*` fields, check git history before assuming they're safe to reuse.

## Turn flow (PvP) — `server.js`

WS message types: `attack`, `switch`, `standby`, `ko_switch`, `use_trainer`, `discard`, `discard_trade`. Handler is one big `if (type === '...')` chain inside `handleMessage(ws, msg)`. `G.turn` (`'p1'|'p2'`) is the authoritative whose-turn-is-it flag; `G.pendingKOSwitch` (role or null) gates forced replacement after a KO — while set, most other message types are rejected.

`G.pendingKOSwitchQueue` (array) — built for 搏命/sacrifice, reused for the double-KO fix — lets **both** sides need a forced replacement in sequence: `pendingKOSwitch` is set to the first side, and once their `ko_switch` resolves, the `ko_switch` handler shifts the next role off the queue automatically. Whether `G.turn` changes during this depends on *why* both died (see Double-KO below) — don't assume it's always the same.

## Trainer cards

`TRAINERS` array (`{id, name, cat:'item'|'supporter'|'stadium', desc}`) + `applyTrainer(card, side/role, ...)` switch statement handle the simple, single-effect cards (heal, buffs, status infliction, orbs, stadiums). Items: unlimited per turn. Supporters: 1/turn, 2/stage(single)or2/game(PvP), **only appear in the opening 3-card hand** (never drawn later — post-opening draws are items-only).

Two cards are too complex for the generic `applyTrainer` switch and are special-cased directly in `useTrainer()`/PvP's `use_trainer` handler instead:
- **搏命 (sacrifice)**: both current actives die simultaneously. Single-player: `resolveMutualKO()`. PvP: inline in the `use_trainer` handler, sets up `pendingKOSwitch`+`pendingKOSwitchQueue` and deliberately does **not** change `G.turn` (the card player keeps their turn once both sides replace — matches single-player's `resolveMutualKO` which returns control to the player afterward, not to the CPU).
- **瘋狂博士 (mad-scientist)**: 2-step selection UI (pick own alive mon → pick opponent's fainted mon) → `transformPokemon()` mutates the chosen mon's identity **in place** (same object reference — this has UI implications, see ui-rendering skill's sprite section). PvP validates both target indices server-side before applying (never trusts client-computed results); client sends `{type:'use_trainer', handIdx, targetOwnIdx, targetEnemyIdx}`.

CPU AI (`cpuUseTrainers()`, single-player only — PvP has no AI) deliberately does **not** know how to play 搏命 or 瘋狂博士 (too complex to integrate safely into the synchronous turn flow) — they'll sit unused in CPU's hand if drawn. This is intentional, not a gap to fill without being asked.

## Status effects

Shape: `{type, turnsLeft}`. `turnsLeft`: sleep 2-3, confusion 2-4, freeze 2 (all random/fixed and count down each turn); poison/burn/paralysis use `999` (i.e. "persists until cured", not turn-limited — paralysis has no countdown at all, just a flat 50%-skip roll every turn regardless of `turnsLeft`).

Tick/skip logic: `handleAttackerStatus()` (single-player) / `handleStatus()` (PvP) — called **only** right before a Pokémon attempts to attack (`playerAttack`/`cpuAttack` / the `attack` WS handler). Never called from switch/standby paths — if you're chasing a "status seems to trigger on switch" report, it's almost certainly the CPU/opponent's *own* status-card usage happening to land on the turn right after a switch, not the switch itself (confirmed via live testing 2026-07-02 — see git log `9ea0f39`-adjacent commit message for the full trace).

CPU will self-cure **any** bad status (including freeze/sleep) with 萬能藥/治療師 if it has one in hand, before even attempting to attack — this is intentional pre-existing AI behavior, not a bug, even though it can look like "the status did nothing." Confirmed with the user this should stay as-is (2026-07-02).

## Damage calc & buffs — `doAttack()`

Buff object `{atkBonus, atkMult, shield, typeOverride, reflect}`, one per side (`G.playerBuff`/`G.cpuBuff` or `G[role+'Buff']`). All four of atkBonus/atkMult/typeOverride/shield reset the instant an attack actually happens (consumed regardless of hit/miss). `reflect` is different — it's meant to persist until the *next* attack lands on that side, however many turns that takes, EXCEPT it must expire if the opponent's turn passes without attacking (switch, standby, or a status-skip) — every one of those turn-ending paths needs an explicit `xBuff.reflect = false`; there is no central place this happens automatically, so if you add a new way for a turn to end without an attack, check whether reflect needs clearing there too (grep `reflect expires` for the existing sites, single-player and server.js each have ~4).

Ability hooks are threaded through `doAttack`: `abilityDmgMult` computed before the damage formula (堅韌/guts), then post-hit `triggerAttackerAbility`/`triggerDefenderAbility` (single-player) or `*Srv` (PvP) for on-attack/on-defend abilities. `triggerOnEnter`/`triggerOnEnterSrv` fire wherever a Pokémon becomes newly active (battle start, switch, KO-switch) — grep call sites before assuming you've covered every "a Pokémon just entered battle" moment, there are ~4-5 distinct call sites per engine.

## KO / double-KO resolution — the trickiest part, read before touching

A Pokémon's death can come from three independent sources in the same exchange: (1) the direct attack damage to the defender, (2) reflect bouncing damage back onto the attacker instead, (3) a defend-ability's recoil (currently only 粗糙皮膚/rough-skin) hitting the attacker *in addition to* the defender taking normal damage. (1)+(2) can't both happen (reflect fully redirects, defender takes zero direct damage that exchange). (1)+(3) **can** both happen — a genuine simultaneous double-KO.

Both engines had (separately discovered, separately fixed 2026-07-02) bugs where checking only the attacker's death and returning early would silently skip ever checking whether the defender *also* died in the same exchange — PvP's version was worse, since it could leave the game state stuck (no winner declared, no forced switch) rather than just misattributing a winner. The fix pattern, if you touch this again: compute **both** `attackerDied`/`defenderDied` booleans up front, handle all 4 combinations explicitly (neither / attacker-only / defender-only / both), and for the both-died case check each side's *remaining team* alive-count independently before deciding win/loss/draw — don't just reuse the single-sided `handleKO`/`pendingKOSwitch` early-return logic, it assumes only one side could possibly be wiped. Single-player has no draw concept — any true double-team-wipe resolves as a player loss (`showResult('cpu')`), matching the precedent set by 搏命. PvP does support `G.winner = 'draw'`.

`bothTeamsWiped()` (single-player helper) and the inline `roleAlive`/`opAlive` checks (PvP) are the canonical way to ask "did both sides just run out of Pokémon" — reuse them rather than re-deriving.
