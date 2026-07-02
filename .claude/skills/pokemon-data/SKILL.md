---
name: pokemon-data
description: Use when adding, editing, or looking up Pokémon (POKEMON array), moves/attacks, types, the type-effectiveness chart (EFF), or the ability (特性) system's data. Triggers on requests like "新增寶可夢", "改招式威力", "加特性", "type chart", "調整屬性相剋", or anything about a specific Pokémon's stats/moves/ability.
---

# Pokémon Data (寶可夢相關)

## Where the data lives — two independent copies, always edit both

| File | Role |
|---|---|
| `pokemon_battle.html` | Single-player source of truth. `public/single.html` is a byte-for-byte mirror — after editing `pokemon_battle.html`, always run `cp pokemon_battle.html public/single.html` and verify with `diff`. |
| `server.js` | PvP source of truth (server-authoritative). Has its own separate `POKEMON`/`TRAINERS` arrays — **not shared** with the HTML files. `public/pvp.html` has no Pokémon data of its own; it only renders whatever the server broadcasts. |

There is no shared data module — this is 4 static HTML/JS files, no build step. Any change to a Pokémon's stats/moves/ability must be made **twice**: once in `pokemon_battle.html` (then synced to `single.html`), once in `server.js`.

## POKEMON entry shape

```js
{ id:26, name:'雷丘', type:'electric', type2:null /* optional */, hp:200, tier:1 /* single-player only, 1-3 */,
  ability:{id:'static', name:'靜電', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入麻痺'}, // optional, see Abilities below
  attacks:[
    {name:'十萬伏特', dmg:40, cost:1, type:'electric', status:{effect:'paralysis', chance:0.30}}, // status optional
    ...always exactly 4 attacks: 2 "weak" (low cost, cost floor ≤ per-turn energy regen) + 2 "strong" (high cost, requires banking energy)
  ]
}
```
`cost` (0-20, added 2026-07-02) is the energy the move consumes — see battle-logic skill's Energy System section for the resource itself. Every Pokémon's 4 moves are deliberately split weak/strong by cost, not flat — don't add a 5th move or break the 2-weak/2-strong shape without deliberately redesigning the tier cost table below.
- `id` is the PokéAPI id — sprites are fetched live from `https://raw.githubusercontent.com/PokeAPI/sprites/...{id}.png` (animated GIF preferred, static PNG fallback), no local assets, no API key. Must be unique across the whole `POKEMON` array (it's used as a set key in roster/swap-candidate generation) — check for collisions against the *real* Pokédex number before adding a species, not just against names (two sessions have picked a species whose real dex number already existed in the roster under a different Chinese name).
- Single-player only: `tier` (1=弱/2=中/3=強, used by `launchStage()` to build the CPU's deck for that stage).
- Roster generation (single-player `pickRandomRoster()`, PvP `randomRoster()` in server.js) — both cap Pokémon with **HP ≥ 300 to at most 1 per generated roster** (added 2026-07-03, shared logic in both engines: shuffle, then skip any HP≥300 candidate once the cap is already filled). Applies to single-player's initial 5-roster draw, its swap-candidate draws, and PvP's initial 6-roster + reroll.
- Battle-instance cloning: single-player `clone()`, PvP `clonePoke()` — both do a shallow `{...p}` plus deep-copy `attacks` and add `cur` (current HP) / `status`. A shallow spread means `ability` carries over automatically — don't need to special-case it when cloning.
- **100 Pokémon total** as of 2026-07-03 (70 original + 30 added that batch). The +30 batch was scoped by explicit user constraint: final-evolution only, no mythical/legendary, no dragon or fairy typing — if asked to add more, ask whether the same constraints still apply rather than assuming.

## Type system

- 16 types: fire/water/grass/electric/psychic/fighting/ghost/dragon/steel/ice/normal/dark/ground/flying/rock/fairy, plus poison/bug (added to `EFF`/`TYPE_ZH`/`TYPE_COLOR` 2026-07-02 — they existed on some Pokémon's data already but the display maps and the `bug` attacker matchup row were missing until then; if a type ever shows as raw English text or always deals neutral damage, check whether it's missing from these maps before assuming the chart itself is wrong).
- `TYPE_COLOR` (hex per type, used for badges) and `TYPE_ZH` (Chinese display name) — simple lookup maps, same in both single-player and PvP client (`public/pvp.html` keeps its own copy for local rendering, but `EFF`/type logic on the PvP side is only used for *display* — actual effectiveness math for damage is computed server-side in `server.js`, see battle-logic skill).
- `EFF` = the raw type chart (`EFF[attackerType][defenderType] → multiplier`). `eff()` reads it; `effActive()` (single-player) / `srvEffActive()` (server.js) additionally apply stadium-card modifiers (反轉世界 inverts the whole chart, 龍之谷 caps dragon-vs-fairy/ice at ×1, 邪惡森林 changes grass's own effectiveness rules) — if you're debugging "why did this deal the wrong damage multiplier," check the active stadium before assuming the chart itself is wrong.
- Dual-type multiplies both types' effectiveness together (can reach ×4 or ×0.25).

## Abilities (特性)

First batch of 6 shipped 2026-07-02, scoped at the time to Pokémon with HP < 250. A second batch of 9 shipped 2026-07-03 alongside the +30 Pokémon addition, with **no HP restriction** (the original HP<250 scoping was a one-off constraint for that first batch, not a standing rule — always confirm with the user before assuming either way).

Post-hit abilities (simple, self-contained in `triggerAttackerAbility`/`triggerDefenderAbility`, don't touch the damage formula):

| Pokémon | ability.id | trigger | Effect |
|---|---|---|---|
| 雷丘、電龍 | `static` | onDefend | 20% paralyze attacker on being hit |
| 沙包蛇 | `intimidate` | onEnter | −15 to opponent's next attack (`buff.atkBonus`) |
| 耿鬼 | `poison-heal` | onStatus | poison heals 1/8 max HP instead of damaging |
| 忍蛙 | `rough-skin` | onDefend | reflects 1/8 attacker's max HP as recoil |
| 三合磁怪 | `static-trail` | onAttack | 15% extra paralyze on hit (custom, not a real Pokémon ability) |
| 羅絲雷朵、天蠍王、大針蜂 | `poison-point` | onDefend | 20% poison attacker on being hit |

Damage-formula abilities (2026-07-03 batch — these needed hooks inside `doAttack` itself, not just the post-hit trigger functions, since they modify the multiplier or intercept the hit entirely; see battle-logic skill's Abilities section for exactly where):

| Pokémon | ability.id | Effect |
|---|---|---|
| 路卡利歐、骨骼獸、尖牙笑鼬、波士可多拉 | `guts` | own status present → ×1.3 damage |
| 掘掘兔、銅鏡怪 | `huge-power` | flat ×1.25 damage, always |
| 巨沼怪、狙射樹梟、鐵臂膀、黑魯加 | `blaze-boost` | own HP ≤ 1/3 AND move matches own type → ×1.5 |
| 老翁蝦、大葉草 | `adaptability` | STAB becomes ×2 instead of ×1.5 |
| 河馬拳、象牙豬 | `thick-fat` | incoming fire/ice damage ×0.6 |
| 太陽岩石、泥偶巨人、鑽角犀獸 | `solid-rock` | incoming ×2+ effectiveness damage ×0.75 |
| 護城蟹、化石盔、冰岩巨獸 | `sturdy` | survives at 1 HP once, only from full HP |
| 水伊布 | `water-absorb` | immune to water moves, heals 1/4 max HP instead (early-return branch, mirrors the existing `reflect` pattern) |
| 寶石海星、通靈鬼 | `frisk-ward` | 25% chance incoming damage ×0.5 |
| 蔥遊兵、諾克拓斯、諾克巨犬、鐵蟬 | `desperate-blade` | own HP ≤ 50% → ×1.3 damage |

**Adding a new ability**: add the `ability:{id,name,trigger,desc}` field to the POKEMON entry (both files), then wire the actual effect — either into `triggerAttackerAbility`/`triggerDefenderAbility` (post-hit, simple) or directly into `doAttack`'s multiplier chain (if it needs to change the damage number itself, intercept the hit, or check pre-hit state like "was at full HP") — the data alone does nothing. **Don't forget the UI won't show it either** unless the Pokémon actually reaches a render path that reads `poke.ability` (already wired for all standard card/popup renders as of 2026-07-02 — see ui-rendering skill's ability-badge section — but double check if you add a new selection screen). Multiple Pokémon can freely share the same `ability.id` — the trigger logic dispatches by id, not by species, so reuse is the norm, not the exception.

## Move power/cost tiers (2026-07-02 rebalance)

All 70 (now 100 — the +30 batch was hand-authored directly into this same tier/cost shape rather than run through the rebalance script) Pokémon's movesets were regenerated by a one-time script (not hand-typed) that sorted each mon's original 4 moves by power, kept the bottom 2 as "weak" and top 2 as "strong", and remapped power+cost into per-tier ranges — original move names/types/status effects were preserved, only `dmg`/`cost` numbers changed:

| Tier | Weak power | Weak cost | Strong power | Strong cost |
|---|---|---|---|---|
| 1 | 30-38 | 0-1 | 65-80 | 10-14 |
| 2 | 35-42 | 1-2 | 75-95 | 13-17 |
| 3 | 40-48 | 2-3 | 85-110 | 16-20 |

Within a tier, where a specific mon lands in its range is interpolated from its *original* total move power relative to other mons in the same tier (not flat per-tier constants) — a mon that had higher power originally still lands closer to the top of its tier's new range. If you add a new Pokémon later, pick `dmg`/`cost` by eyeballing this table for its tier rather than reusing another mon's exact numbers.

## Trainer cards reference the same POKEMON pool indirectly

Some cards (交換器/switcher, 瘋狂博士/mad-scientist) pick Pokémon *from the current battle's decks*, not from the master POKEMON list — see battle-logic skill for the card system itself; this skill only covers the underlying species/move/type/ability data.
