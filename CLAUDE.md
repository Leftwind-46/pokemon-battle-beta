# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A collection of standalone single-file HTML pages — no build system, no package manager, no server required. Each file is self-contained: HTML structure, `<style>`, and `<script>` all in one file. Open directly in a browser.

## Files

| File | Description |
|---|---|
| `index.html` | 寶可夢綠寶石・天氣三神獸 — static info page about Groudon/Kyogre/Rayquaza |
| `bmi.html` | BMI 健康計算機 — BMI calculator |
| `pokemon_battle.html` | 寶可夢卡牌對戰 — full card battle game (see below) |
| `hello_world.py` | Scratch file |

## Running

Open any `.html` file directly in a browser — no dev server needed:
```
open pokemon_battle.html
```

## Design conventions

All pages share the same visual language:
- **Dark background**: `#07091a`
- **Glass surfaces**: `rgba(255,255,255,0.04–0.05)` with `rgba(255,255,255,0.10)` border
- **Text**: `#e8eaf6` primary, `#7986cb` muted
- **Language**: Traditional Chinese (`lang="zh-TW"`)
- **Animated star canvas** (`#stars`, fixed, `z-index:0`) as background — defined in a self-invoking function at the top of each `<script>`
- CSS custom properties in `:root` for all theme values

## `pokemon_battle.html` architecture

The game is a single `<script>` block (~700 lines). Key sections in order:

### Data layer
- `POKEMON[]` — 17 Pokémon entries: `{ id, name, type, hp, attacks:[{name,dmg}×2] }`. Sprites fetched from `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{id}.png` (no API key, static CDN).
- `TYPE_COLOR`, `TYPE_ZH` — display maps for each type string
- `EFF{}` — type effectiveness chart: `EFF[attackerType][defenderType] → multiplier`
- `TRAINERS[]` — 8 trainer card definitions: `{ id, name, cat:'item'|'supporter', desc }`

### State
Single mutable object `G`:
```js
{
  playerDeck, cpuDeck,          // arrays of cloned Pokémon objects (have `.cur` for current HP)
  playerIdx, cpuIdx,            // active Pokémon index into each deck
  round, busy, selected,
  playerHand, cpuHand,          // trainer card hands
  playerSuppUsed, cpuSuppUsed,  // supporter-per-turn flag
  freeSwitch,                   // true after player uses 換人命令
  playerBuff, cpuBuff,          // { atkBonus, atkMult, shield } — reset after each attack
}
```
`P()` and `CP()` are shorthand getters for the active Pokémon.

### Screen flow
Four screens toggled via `.active` class: `start-screen → battle-screen → result-screen`. The select screen exists in HTML but is bypassed — `startRandomBattle()` shuffles all Pokémon and deals 3 to each side directly.

### Turn flow
```
playerAttack(i) / playerSwitch(i)
  └─ doAttack(player→cpu) → cpuAttack()
       └─ cpuUseTrainers()  [CPU plays trainer cards]
          └─ doAttack(cpu→player)
               └─ handleKO(side, cb) if HP ≤ 0
                    └─ showResult() if no survivors, else cb()
```
`G.busy = true` disables all player input during animations. It resets to `false` (with `renderBattle()`) only after the full CPU response chain completes.

### Trainer card system
- `dealHand(n)` — shuffles `TRAINERS[]` and slices n cards
- `useTrainer(idx)` — player uses a hand card; removes it, calls `applyTrainer`, re-renders
- `applyTrainer(card, side)` — applies effect and logs message; modifies `G.*Buff` or Pokémon `.cur` directly
- CPU calls `cpuUseTrainers()` at the start of each CPU turn (heals when HP < 40%, uses attack buffs before attacking)
- Buffs (`atkBonus`, `atkMult`, `shield`) are consumed and reset inside `doAttack` on the turn they apply
