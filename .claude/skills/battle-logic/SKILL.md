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

`TRAINERS` array (`{id, name, cat:'item'|'supporter'|'stadium', desc}`) + `applyTrainer(card, side/role, ...)` switch statement handle the simple, single-effect cards (heal, buffs, status infliction, orbs, stadiums, energy). Items: unlimited per turn. Supporters: **1/turn, no per-stage/per-game cap** (the old "2/stage(single) or 2/game(PvP)" limit was removed 2026-07-02 at the user's request — only the `SuppUsed`-per-turn flag remains; `SuppStageUsed` still increments but nothing reads it as a gate anymore), **only appear in the opening 3-card hand** (never drawn later — post-opening draws are items-only).

Two cards are too complex for the generic `applyTrainer` switch and are special-cased directly in `useTrainer()`/PvP's `use_trainer` handler instead:
- **搏命 (sacrifice)**: both current actives die simultaneously. Single-player: `resolveMutualKO()`. PvP: inline in the `use_trainer` handler, sets up `pendingKOSwitch`+`pendingKOSwitchQueue` and deliberately does **not** change `G.turn` (the card player keeps their turn once both sides replace — matches single-player's `resolveMutualKO` which returns control to the player afterward, not to the CPU).
- **瘋狂博士 (mad-scientist)**: 2-step selection UI (pick own alive mon → pick opponent's fainted mon) → `transformPokemon()` mutates the chosen mon's identity **in place** (same object reference — this has UI implications, see ui-rendering skill's sprite section). PvP validates both target indices server-side before applying (never trusts client-computed results); client sends `{type:'use_trainer', handIdx, targetOwnIdx, targetEnemyIdx}`.

CPU AI (`cpuUseTrainers()`, single-player only — PvP has no AI) deliberately does **not** know how to play 搏命 or 瘋狂博士 (too complex to integrate safely into the synchronous turn flow) — they'll sit unused in CPU's hand if drawn. This is intentional, not a gap to fill without being asked.

## Status effects

Shape: `{type, turnsLeft}`. `turnsLeft`: sleep 2-3, confusion 2-4, freeze 2 (all random/fixed); poison/burn/paralysis use `999` (i.e. "persists until cured", not turn-limited — paralysis has no countdown at all, just a flat 50%-skip roll every attack attempt regardless of `turnsLeft`).

**Two-phase model (reworked 2026-07-03)** — status resolution is split into "does it block acting" (only relevant when *attempting to attack*) and "does it tick/deal damage at turn end" (relevant on every turn regardless of what the Pokémon did):

- **Attack-gating** (`handleAttackerStatus()` single-player / `handleStatus()` PvP, called only from `playerAttack`/`cpuAttack`/the `attack` WS handler): sleep/freeze/paralysis may block the attempt (`onSkip`); confusion may force a self-hit instead of the intended move. Poison/burn **never** resolve here anymore — they always let the attempt through untouched.
- **End-of-turn damage** (`applyEndOfTurnStatus()` single-player / `applyEndOfTurnStatusSrv()` PvP): applies poison/burn damage (or poison-heal ability healing) *after* the turn's action has already resolved — whether that action was a landed attack, an attack blocked by sleep/paralysis/freeze, or a standby. This is why a poisoned Pokémon at 1 HP still gets to swing before it faints, instead of dying before its move — matches mainline Pokémon timing, was a deliberate 2026-07-03 fix per user report ("中毒的寶可夢還沒攻擊就倒下了").
- **Non-attack duration tick** (`tickNonAttackStatus()` single-player / `tickNonAttackStatusSrv()` PvP): decrements sleep/freeze/confusion `turnsLeft` on a turn where the Pokémon didn't attempt to attack (standby, or single-player's CPU-can't-afford-any-move branch) — no blocking, no confusion self-hit, just the countdown (and wake-up message) so standby genuinely progresses toward recovery instead of leaving the counter frozen forever.

Every turn-ending call site needs to call the right combination of these — grep existing call sites in `playerAttack`/`cpuAttack`/`playerStandby` (single-player) and the `attack`/`standby` WS handlers (PvP) before adding a new one. The trickiest wrinkle: applying poison/burn *after* an attack can newly kill an attacker that survived the attack exchange itself — in PvP this is handled by applying the tick and *then* computing `attackerDied`, so the existing double-KO/attacker-only/defender-only/neither branching (see KO resolution below) picks it up automatically; single-player does the equivalent via a shared `tickAndHandoff`/`tickAndEndTurn` closure that wraps whichever path the turn took.

CPU will self-cure **any** bad status (including freeze/sleep) with 萬能藥/治療師 if it has one in hand, before even attempting to attack — this is intentional pre-existing AI behavior, not a bug, even though it can look like "the status did nothing." Confirmed with the user this should stay as-is (2026-07-02).

## Damage calc & buffs — `doAttack()`

Buff object `{atkBonus, atkMult, shield, typeOverride, reflect}`, one per side (`G.playerBuff`/`G.cpuBuff` or `G[role+'Buff']`). All four of atkBonus/atkMult/typeOverride/shield reset the instant an attack actually happens (consumed regardless of hit/miss). `reflect` is different — it's meant to persist until the *next* attack lands on that side, however many turns that takes, EXCEPT it must expire if the opponent's turn passes without attacking (switch, standby, or a status-skip) — every one of those turn-ending paths needs an explicit `xBuff.reflect = false`; there is no central place this happens automatically, so if you add a new way for a turn to end without an attack, check whether reflect needs clearing there too (grep `reflect expires` for the existing sites, single-player and server.js each have ~4).

Ability hooks are threaded through `doAttack` two ways — pick whichever fits the effect (see pokemon-data skill for the full roster of which ability uses which):
- **Post-hit** (`triggerAttackerAbility`/`triggerDefenderAbility` single-player, `*Srv` PvP): fired *after* damage is already applied, for effects that don't change the damage number itself (静電/static, 毒刺/poison-point inflicting a status; 粗糙皮膚/rough-skin dealing separate recoil). Simplest, least risky to add.
- **In-formula** (added 2026-07-03 for 9 new abilities): `abilityDmgMult` (attacker-side: 堅韌/guts, 大力士/huge-power, 激流-family/blaze-boost), `stabMult` (適應力/adaptability bumps it from 1.5→2), and a `defAbilityMult` product (厚脂肪/thick-fat, 硬岩/solid-rock, 神秘之守/frisk-ward) are all computed *before* the `dmg =` line and multiplied directly into the formula. Two abilities don't fit even that: `water-absorb` (儲水) is an early-return branch right after the `reflect` check — full immunity, heals instead, never reaches the damage formula at all — and `sturdy` (頑強) captures `wasFullHp = defender.cur === defender.hp` *before* the formula runs, then clamps `defender.cur` to 1 right after it's decremented, but only if that pre-hit snapshot was true. If you add another ability that needs to know pre-hit state, follow the `wasFullHp` pattern — capture the snapshot before any mutation, not after.

`triggerOnEnter`/`triggerOnEnterSrv` fire wherever a Pokémon becomes newly active (battle start, switch, KO-switch) — grep call sites before assuming you've covered every "a Pokémon just entered battle" moment, there are ~4-5 distinct call sites per engine.

Multiple Pokémon commonly share one `ability.id` — the dispatch is by id (`if (attacker.ability?.id === 'guts')`), not hardcoded per species, so giving two different Pokémon the same ability is the normal case, not a special one.

## Energy system (2026-07-02)

Every side has energy (`G.playerEnergy`/`G.cpuEnergy` single-player, `G.p1Energy`/`G.p2Energy` PvP), 0-20, starts at 5, `+3` capped at 20 at the start of *that side's own turn* — single-player hooks this into the exact same two spots that already fire once per turn-start (`cpuAttack()`'s top for CPU, `drawAfterTurn()` for the player); PvP hooks it into `drawForRole(G, role)`, which is already the single canonical "this role's turn is genuinely starting" function (correctly handles the KO-switch-queue-deferred case too — see pvp-networking skill). Resets to 5 on a new single-player stage / new PvP game, same place HP gets fully healed.

Each move's `cost` (see pokemon-data skill) is deducted right before `doAttack` actually fires — never on a status-skip. **PvP validates energy server-side** in the `attack` WS handler (`if (G[role+'Energy'] < atk.cost) reject`) before trusting `msg.idx` — client-side button disabling is a UX nicety only, not the real guard. CPU (single-player only) filters its move choices down to `cost <= G.cpuEnergy` before applying its usual damage-preference logic; if literally nothing is affordable it skips the attack via the same `onSkip`/`endTurn` path status-skips already use. In practice this branch rarely fires — every tier's weak-move cost ceiling is ≤ the flat +3 regen, so some move is affordable right after any turn-start regen by construction.

Energy-granting cards: 3 items (`energy-patch-s/m/l`, +2/+3/+4) and 1 supporter (`cheerleader`, fills to 20) — same `applyTrainer` switch as everything else. The discard-2-for-1 trade modal (`chooseTrade()`/PvP `discard_trade`) has a third option beyond stadium/item: `cardType:'energy'` grants +5 instead of drawing a card.

## KO / double-KO resolution — the trickiest part, read before touching

A Pokémon's death can come from three independent sources in the same exchange: (1) the direct attack damage to the defender, (2) reflect bouncing damage back onto the attacker instead, (3) a defend-ability's recoil (currently only 粗糙皮膚/rough-skin) hitting the attacker *in addition to* the defender taking normal damage. (1)+(2) can't both happen (reflect fully redirects, defender takes zero direct damage that exchange). (1)+(3) **can** both happen — a genuine simultaneous double-KO.

Both engines had (separately discovered, separately fixed 2026-07-02) bugs where checking only the attacker's death and returning early would silently skip ever checking whether the defender *also* died in the same exchange — PvP's version was worse, since it could leave the game state stuck (no winner declared, no forced switch) rather than just misattributing a winner. The fix pattern, if you touch this again: compute **both** `attackerDied`/`defenderDied` booleans up front, handle all 4 combinations explicitly (neither / attacker-only / defender-only / both), and for the both-died case check each side's *remaining team* alive-count independently before deciding win/loss/draw — don't just reuse the single-sided `handleKO`/`pendingKOSwitch` early-return logic, it assumes only one side could possibly be wiped. Single-player has no draw concept — any true double-team-wipe resolves as a player loss (`showResult('cpu')`), matching the precedent set by 搏命. PvP does support `G.winner = 'draw'`.

`bothTeamsWiped()` (single-player helper) and the inline `roleAlive`/`opAlive` checks (PvP) are the canonical way to ask "did both sides just run out of Pokémon" — reuse them rather than re-deriving.
