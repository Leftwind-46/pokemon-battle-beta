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
- **Chinese name accuracy — verify, don't recall from memory.** The +30 batch (2026-07-03) shipped with ~19/30 Traditional Chinese names wrong (invented/misremembered rather than the real Taiwan localization), plus one dex-id error (assigned Golisopod id 979, which is actually some Gen-9 Pokémon — its real id is 768) and a pre-existing error in the original 70 (穿山王/Sandslash had been mislabeled 沙包蛇). All were caught by the user visually comparing sprite to name and fixed the same day by checking every entry against `https://tw.portal-pokemon.com/play/pokedex/{4-digit-id}_0` (use `_1` if `_0` 404s — some Pokémon, like Mega/Crowned forms, only exist under `_1`; also watch for internal PokeAPI form-variant ids like `10188` that aren't real dex numbers at all — cross-check with a plain web search for "{species} 全國圖鑑編號" if a fetch looks suspicious). **Before typing a Chinese Pokémon name from memory, verify it this way first** — recall accuracy for anything beyond famous Gen 1/2 species has proven unreliable.

## Type system

- 16 types: fire/water/grass/electric/psychic/fighting/ghost/dragon/steel/ice/normal/dark/ground/flying/rock/fairy, plus poison/bug (added to `EFF`/`TYPE_ZH`/`TYPE_COLOR` 2026-07-02 — they existed on some Pokémon's data already but the display maps and the `bug` attacker matchup row were missing until then; if a type ever shows as raw English text or always deals neutral damage, check whether it's missing from these maps before assuming the chart itself is wrong).
- `TYPE_COLOR` (hex per type, used for badges) and `TYPE_ZH` (Chinese display name) — simple lookup maps, same in both single-player and PvP client (`public/pvp.html` keeps its own copy for local rendering, but `EFF`/type logic on the PvP side is only used for *display* — actual effectiveness math for damage is computed server-side in `server.js`, see battle-logic skill).
- `EFF` = the raw type chart (`EFF[attackerType][defenderType] → multiplier`). `eff()` reads it; `effActive()` (single-player) / `srvEffActive()` (server.js) additionally apply stadium-card modifiers (反轉世界 inverts the whole chart, 龍之谷 caps dragon-vs-fairy/ice at ×1, 邪惡森林 changes grass's own effectiveness rules) — if you're debugging "why did this deal the wrong damage multiplier," check the active stadium before assuming the chart itself is wrong.
- Dual-type multiplies both types' effectiveness together (can reach ×4 or ×0.25).

## Abilities (特性)

**All 100/100 Pokémon have an ability as of 2026-07-04.** History: first batch of 6 shipped 2026-07-02 (HP<250 only, a one-off scoping, not a standing rule). A batch of 9 shipped 2026-07-03 alongside the +30 Pokémon addition, invented/loosely-matched to real abilities. Two further batches (19, then the remaining 45) shipped 2026-07-04 for the *original* 70 — every one of these individually verified against the Pokémon's real in-game ability via the official Taiwan site before being coded (see the name-accuracy note above — same lesson applied to abilities; many legendaries' real abilities are weather/terrain/PP-based mechanics this game has no system for, so those were deliberately reused against the closest existing effect with the real ability name kept for display — see the "no clean mechanical fit" rows below).

Post-hit abilities (simple, self-contained in `triggerAttackerAbility`/`triggerDefenderAbility`, don't touch the damage formula):

| Pokémon | ability.id | trigger | Effect |
|---|---|---|---|
| 雷丘、電龍 | `static` | onDefend | 20% paralyze attacker on being hit |
| 穿山王、暴鯉龍、肯泰羅、阿柏怪、姆克鷹、風速狗、布魯皇、流氓鱷 | `intimidate` | onEnter | opponent's next attack damage ×0.5 (`opBuff.atkMult = Math.min(opBuff.atkMult, 0.5)`) — **changed 2026-07-04 from a flat `atkBonus -= 15`**, which the user found too weak; also dropped the `clear-body` interaction check entirely when `clear-body` was retired the same day, see below |
| 耿鬼 | `poison-heal` | onStatus | poison heals 1/8 max HP instead of damaging |
| 甲賀忍蛙 | `rough-skin` | onDefend | reflects 1/8 attacker's max HP as recoil |
| 三合一磁怪 | `static-trail` | onAttack | 15% extra paralyze on hit (custom, not a real Pokémon ability) |
| 羅絲雷朵、龍王蠍、大針蜂、毒刺水母 | `poison-point` | onDefend | 20% poison attacker on being hit |
| 鋼鎧鴉、黑夜魔靈、超夢、鳳王、洛奇亞、急凍鳥、閃電鳥、火焰鳥、帝牙盧卡、帕路奇亞、化石翼龍 | `pressure` | onEnter + continuous | onEnter: opponent loses 3 energy. **Extended 2026-07-04**: while this Pokémon is the active defender, the opponent's move costs +2 energy (capped at 20 total, via `effectiveCost(atk, opponentPoke)`/`effectiveCostSrv` — see battle-logic skill for every call site this touches) — real Pressure drains PP continuously for as long as it's on the field, so the onEnter-only drain undersold it; this is why so many legendaries share this id, Pressure is extremely common among them |
| 皮皮 | `magic-guard` | onStatus (checked in `applyEndOfTurnStatus`) | skips poison/burn end-of-turn damage entirely |
| 呆殼獸 | `own-tempo` | onDefend (checked in `tryInflictStatus` + the 混亂藥/confuse-potion card case) | blocks confusion specifically; other statuses unaffected |
| 胡地、沙奈朵 | `sync-status` | onDefend (checked in `tryInflictStatus`, after a poison/paralysis/burn infliction succeeds) | copies the same status onto the attacker, if the attacker has none (real Synchronize) |
| 烏鴉頭頭 | `insomnia` | onDefend (checked in `tryInflictStatus`, mirrors `own-tempo`'s pattern) | blocks sleep specifically |
| 鴨嘴炎獸、烈箭鷹 | `flame-body` | onDefend (mirrors `poison-point`'s pattern) | 20% burn attacker on being hit |

**`clear-body` is retired — do not reintroduce it.** It shipped 2026-07-04 morning as "blocks incoming `intimidate`" for 巨金怪/毒刺水母/雷吉艾斯/快龍, but the user judged that effect too weak the same day and asked for it to be replaced outright, with an explicit instruction never to add it again. All four were reassigned to existing effects instead: 巨金怪→`solid-rock`("硬岩"), 毒刺水母→`poison-point`("毒刺", its actual real second ability), 雷吉艾斯→`thick-fat`("厚脂肪"), 快龍→**new** `multiscale`("多重鱗片", see below — this one got a real new effect instead of a reuse because Dragonite's actual hidden ability, Multiscale, is genuinely distinctive and cleanly implementable). The `intimidate`-vs-`clear-body` interaction code (an opponent-ability check inside `intimidate`'s own trigger) was deleted along with it — don't re-add that check pattern for a future ability without checking this history first.

Damage-formula abilities (need hooks inside `doAttack` itself, not just the post-hit trigger functions, since they modify the multiplier, intercept the hit, or need pre-hit state — see battle-logic skill's Abilities section for exactly where each pattern goes):

| Pokémon | ability.id | Effect |
|---|---|---|
| 路卡利歐、嘎啦嘎啦、堵攔熊、劈斬司令、怪力、赫拉克羅斯 | `guts` | own status present → ×1.3 damage |
| 掘地兔、鐵蟻 | `huge-power` | flat ×1.25 damage, always |
| 阿勃梭魯、固拉多、烈空坐、蒼響、龍捲雲 | `huge-power` | reused id — real abilities are 超幸運/Super Luck (crit rate), 日照/Drought, 氣閘/Air Lock, 不撓之劍/Intrepid Sword, 惡作劇之心/Prankster respectively; none have a mechanical fit here (no crit/weather/terrain/priority systems), all reused as the generic "hits harder" fallback with the real name kept for display |
| 巨沼怪、狙射樹梟、具甲武者、黑魯加、妙蛙花、大力鱷、噴火龍、水箭龜、火爆獸、大竺葵、密勒頓、故勒頓、熾焰咆哮虎、蜥蜴王、巨鉗螳螂 | `blaze-boost` | own HP ≤ 1/3 AND move matches own type → ×1.5 (covers every real Overgrow/Torrent/Blaze/Swarm-family ability — all mechanically identical in-game — plus 密勒頓/強子引擎 and 故勒頓/緋紅脈動, whose real terrain/weather effects have no system here so they're reused the same way) |
| 鐵螯龍蝦、巨蔓藤 | `adaptability` | STAB becomes ×2 instead of ×1.5 |
| 蓋歐卡、哲爾尼亞斯、伊裴爾塔爾 | `adaptability` | reused id — real abilities are 降雨/Drizzle, 妖精氣場/Fairy Aura, 暗黑氣場/Dark Aura (all boost-your-own-or-allies'-matching-type-moves in some form), no weather/aura system here so reused as "boosts own STAB" |
| 鐵掌力士、象牙豬、白海獅、卡比獸、雷吉艾斯 | `thick-fat` | incoming fire/ice damage ×0.6 |
| 太陽岩、泥偶巨人、超甲狂犀、班基拉斯、巨金怪 | `solid-rock` | incoming ×2+ effectiveness damage ×0.75 (班基拉斯's real ability 揚沙/Sand Stream has no weather system, reused for its tanky-rock-type theme; 巨金怪 reassigned here 2026-07-04 after `clear-body` was retired) |
| 岩殿居蟹、護城龍、冰岩怪、龐岩怪 | `sturdy` | survives at 1 HP once, only from full HP |
| 快龍 | `multiscale` | incoming damage ×0.5 if defender was at full HP before the hit — **new 2026-07-04**, replaces `clear-body`; mirrors `sturdy`'s `wasFullHp` snapshot pattern but reduces damage instead of clamping HP to 1. Real Multiscale is Dragonite's actual hidden ability, chosen over its other real ability (Inner Focus) because it has a genuine mechanical fit here |
| 水伊布 | `water-absorb` | immune to water moves, heals 1/4 max HP instead (early-return branch, mirrors the existing `reflect` pattern) |
| 毒骷蛙、拉普拉斯 | `water-absorb` | reused id, displayed as "乾燥皮膚"/Dry Skin and "儲水"/Water Absorb (the latter is an exact real match) — Dry Skin's real fire-vulnerability half isn't modeled, only the water-heals half |
| 寶石海星、哥德小姐 | `frisk-ward` | 25% chance incoming damage ×0.5 |
| 爆音怪、烈咬陸鯊、仙子伊布、雪妖女、凍原熊 | `frisk-ward` | reused id — real abilities are 隔音/Soundproof, 沙隱/Sand Veil, 迷人之軀/Cute Charm, 雪隱/Snow Cloak ×2 (evasion/contact/sound-immunity effects with no system here), all reused as generic damage-reduction chance |
| 蔥遊兵、貓老大、長毛狗、鍬農炮蟲 | `desperate-blade` | own HP ≤ 50% → ×1.3 damage |
| 遠古巨蜓 | `tinted-lens` | if this Pokémon's move is resisted (0 < mult < 1, not full immunity), cancel the resistance back to ×1 by multiplying by `1/mult` |
| 電擊魔獸 | `motor-drive` | immune to electric-type moves, gains 3 energy instead (early-return branch, mirrors `water-absorb`'s pattern but energy instead of HP — real Motor Drive boosts Speed, no speed stat here) |
| 水晶燈火靈 | `flash-fire` | immune to fire-type moves, `dBuff.atkBonus += 20` for its next attack instead (early-return branch, mirrors `water-absorb`'s pattern but a one-time atk buff instead of a heal) |

**Adding a new ability**: add the `ability:{id,name,trigger,desc}` field to the POKEMON entry (both files), then wire the actual effect — either into `triggerAttackerAbility`/`triggerDefenderAbility` (post-hit, simple), directly into `doAttack`'s multiplier chain (damage-number changes, hit interception, pre-hit-state checks), or into `tryInflictStatus`/`triggerOnEnter` (status-infliction-time or enter-time interactions like `own-tempo`/`insomnia`/`sync-status`/`pressure`) — the data alone does nothing. **Don't forget the UI won't show it either** unless the Pokémon actually reaches a render path that reads `poke.ability` (wired for all standard card/popup renders plus the single-player Pokédex tab as of 2026-07-04 — see ui-rendering skill's ability-badge section — but double check if you add a new selection screen; PvP has no Pokédex tab). Multiple Pokémon can freely share the same `ability.id` even with **different `name`/`desc` text** per entry (e.g. `blaze-boost` displays as "茂盛"/"激流"/"猛火"/"強子引擎"/etc depending on species) — the dispatch is purely by `id`, so reuse-with-relabeling is the norm whenever a real ability doesn't cleanly map to a new mechanic (very common for legendaries whose signature abilities are weather/terrain/crit/PP-based — this game has none of those systems); only invent a new `id` when no existing effect fits even loosely — but see `multiscale` above for a case where a genuine real-ability fit was worth adding new code instead of reusing something. 26 unique `ability.id` values exist as of 2026-07-04 evening (verify with `new Set(POKEMON.filter(p=>p.ability).map(p=>p.ability.id)).size` rather than trusting a stale count in this doc) — **`clear-body` is retired and must not be reintroduced**, see the retirement note above.

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
