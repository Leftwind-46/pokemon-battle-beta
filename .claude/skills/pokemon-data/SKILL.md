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
- `id` is the PokéAPI id — sprites are fetched live from `https://raw.githubusercontent.com/PokeAPI/sprites/...{id}.png` (animated GIF preferred, static PNG fallback), no local assets, no API key.
- Single-player only: `tier` (1=弱/2=中/3=強, ~15/15/13 mons per tier, used by `launchStage()` to build the CPU's deck for that stage).
- PvP rosters (`randomRoster()` in server.js) sample 6 unique Pokémon from the full `POKEMON` array with a shuffle+slice — **no duplicate species possible in a PvP roster** (relevant if you touch sprite-identity logic, see ui-rendering skill).
- Battle-instance cloning: single-player `clone()`, PvP `clonePoke()` — both do a shallow `{...p}` plus deep-copy `attacks` and add `cur` (current HP) / `status`. A shallow spread means `ability` carries over automatically — don't need to special-case it when cloning.

## Type system

- 16 types: fire/water/grass/electric/psychic/fighting/ghost/dragon/steel/ice/normal/dark/ground/flying/rock/fairy.
- `TYPE_COLOR` (hex per type, used for badges) and `TYPE_ZH` (Chinese display name) — simple lookup maps, same in both single-player and PvP client (`public/pvp.html` keeps its own copy for local rendering, but `EFF`/type logic on the PvP side is only used for *display* — actual effectiveness math for damage is computed server-side in `server.js`, see battle-logic skill).
- `EFF` = the raw type chart (`EFF[attackerType][defenderType] → multiplier`). `eff()` reads it; `effActive()` (single-player) / `srvEffActive()` (server.js) additionally apply stadium-card modifiers (反轉世界 inverts the whole chart, 龍之谷 caps dragon-vs-fairy/ice at ×1, 邪惡森林 changes grass's own effectiveness rules) — if you're debugging "why did this deal the wrong damage multiplier," check the active stadium before assuming the chart itself is wrong.
- Dual-type multiplies both types' effectiveness together (can reach ×4 or ×0.25).

## Abilities (特性)

First batch of 6 shipped 2026-07-02, deliberately scoped to Pokémon with **HP < 250** (per an earlier explicit user constraint — don't silently expand this pool without checking with the user first).

| Pokémon | ability.id | trigger | Effect |
|---|---|---|---|
| 雷丘 | `static` | onDefend | 20% paralyze attacker on being hit |
| 沙包蛇 | `intimidate` | onEnter | −15 to opponent's next attack (`buff.atkBonus`) |
| 耿鬼 | `poison-heal` | onStatus | poison heals 1/8 max HP instead of damaging |
| 路卡利歐 | `guts` | onAttack | own status present → ×1.3 damage |
| 忍蛙 | `rough-skin` | onDefend | reflects 1/8 attacker's max HP as recoil |
| 三合磁怪 | `static-trail` | onAttack | 15% extra paralyze on hit (custom, not a real Pokémon ability) |

**Adding a new ability**: add the `ability:{id,name,trigger,desc}` field to the POKEMON entry (both files), then wire the actual effect into the trigger hooks described in the battle-logic skill — the data alone does nothing. **Don't forget the UI won't show it either** unless the Pokémon actually reaches a render path that reads `poke.ability` (already wired for all standard card/popup renders as of 2026-07-02 — see ui-rendering skill's ability-badge section — but double check if you add a new selection screen).

## Move power/cost tiers (2026-07-02 rebalance)

All 70 Pokémon's movesets were regenerated by a one-time script (not hand-typed) that sorted each mon's original 4 moves by power, kept the bottom 2 as "weak" and top 2 as "strong", and remapped power+cost into per-tier ranges — original move names/types/status effects were preserved, only `dmg`/`cost` numbers changed:

| Tier | Weak power | Weak cost | Strong power | Strong cost |
|---|---|---|---|---|
| 1 | 30-38 | 0-1 | 65-80 | 10-14 |
| 2 | 35-42 | 1-2 | 75-95 | 13-17 |
| 3 | 40-48 | 2-3 | 85-110 | 16-20 |

Within a tier, where a specific mon lands in its range is interpolated from its *original* total move power relative to other mons in the same tier (not flat per-tier constants) — a mon that had higher power originally still lands closer to the top of its tier's new range. If you add a new Pokémon later, pick `dmg`/`cost` by eyeballing this table for its tier rather than reusing another mon's exact numbers.

## Trainer cards reference the same POKEMON pool indirectly

Some cards (交換器/switcher, 瘋狂博士/mad-scientist) pick Pokémon *from the current battle's decks*, not from the master POKEMON list — see battle-logic skill for the card system itself; this skill only covers the underlying species/move/type/ability data.
