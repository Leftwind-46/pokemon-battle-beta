---
name: adding-cards
description: Checklist to run through when adding or modifying a trainer card (道具/支援者/競技場). Use BEFORE writing code, not after — this is the single most common recurring bug source in this repo (a new card added to one list but not its sibling list). Triggers on "新增卡片", "新增競技場", "新增道具", "新增支援者卡".
---

# Adding a trainer card — checklist

Read this **before** editing, not as a post-hoc review. The single most common bug in this project's history is "added a new card to `TRAINERS` but forgot one of the other places that need to know about it" — this has happened at least 4 separate times (see battle-logic skill's Trainer cards section for the full incident history). This checklist exists to make that mechanical instead of memory-dependent.

For the *why* behind any item below, see battle-logic/pokemon-data skill — this file is deliberately just the *what*.

## Every new card, no exceptions

- [ ] Add the `{id, name, cat, desc}` entry to `TRAINERS` in **`pokemon_battle.html`**
- [ ] Add the identical entry to `TRAINERS` in **`server.js`**
- [ ] Add the effect to `applyTrainer()`'s switch in **`pokemon_battle.html`** (new `case`, or fold into an existing shared case if the effect matches one already there — e.g. the 4-tier potion map)
- [ ] Add the identical effect to `applyTrainer()`'s switch in **`server.js`**
- [ ] Add one line to the in-game rules/guide modal text in **`pokemon_battle.html`** (`<li>卡名 — 效果說明</li>`, grep an existing sibling line for the exact spot)
- [ ] Decide explicitly: does CPU AI (`cpuUseTrainers()`, single-player only) need to know how to use this card? Default is **no** unless it's a simple heal/buff that fits the existing greedy patterns — 搏命/瘋狂博士-complexity cards are deliberately left unplayed by CPU (established precedent, not a gap)
- [ ] `cp pokemon_battle.html public/single.html`
- [ ] `npm run verify` — catches syntax errors, sync drift, and (critically) TRAINERS/switch-case mismatches automatically

## Additionally, if it's a `cat:'stadium'` card

- [ ] Add its id to the **generic stadium-activation switch case** in `applyTrainer()`, in **both** files — this is a hand-enumerated `case 'stadium-a': case 'stadium-b': ... {` list, not automatic. `npm run verify` checks this specific thing and will fail loudly if you skip it, but grep it yourself first: `grep -n "case 'stadium-" pokemon_battle.html`
- [ ] If it changes type effectiveness (immunity removal, forced super-effective, resistance negation): add an override block to `effActive()` (`pokemon_battle.html`) and `srvEffActive()` (`server.js`) — both are a sequence of `if (G.activeStadium?.id === '...') { ... }` blocks ending in `return m;`; append yours before the final return, after the existing blocks
- [ ] If it changes damage output: add a new `xMult` local (e.g. `colosseumMult`, `lavaMult`) folded into `doAttack()`'s final `dmg`/`damage` multiplier chain, **in both engines** — grep `megaBoostMult` in each file to find the exact line
- [ ] If it changes move energy cost: add to `effectiveCost()` (`pokemon_battle.html`) and `effectiveCostSrv()` (`server.js`) — check `effectiveCostSrv`'s signature actually has a `G` parameter before assuming you can read `G.activeStadium` inside it (it didn't, historically, until 海洋世界 needed it — if you add a parameter to a shared helper, grep every call site of that helper before assuming they all still work)

## Additionally, if the card needs a brand-new UI element (a picker modal, a new badge, etc.)

- [ ] New modal needs **both** halves of its CSS: the base `display:none` rule *and* the `.open { display:... }` rule that shows it — adding only the first (easy to do, since you write it first and the bug is invisible until someone tries to actually open it) has happened at least twice. Grep every existing modal's CSS pair (`#discard-modal`/`#discard-modal.open`) as the template.
- [ ] If it's a mobile-relevant element and any unconditional (non-media-query) rule for the same selector appears **later** in the same `<style>` block, your `@media` rule loses on source order regardless of the media condition — needs `!important` on every overridden property (see ui-rendering skill's `!important` note for the full explanation)

## Additionally, if the card's effect spans across a turn boundary (a "next turn" or "opponent's next attack" effect)

- [ ] Decide up front which consumption pattern fits: **promote-then-consume** (player-UI style — the effect needs checking on *every* action attempt across a whole turn, e.g. 通訊封印 blocking every `useTrainer()` call that turn) vs **read-and-clear-once** (CPU-AI-batch style — the consumer is a single function call per turn, e.g. `cpuUseTrainers()`). Using the wrong one either double-clears too early or never clears at all — see battle-logic skill's 通訊封印 section for both patterns fully worked out.
- [ ] If the effect adds a card to the player's own hand (a "steal" mechanic like 掠奪, not a "discard" mechanic): check the 5-card hand cap — single-player via `showDiscardModal(() => {})`, PvP via setting `G[role+'NeedsDiscard']`

## Before calling it done

- [ ] `npm run verify` one more time, clean
- [ ] Single-player: live-test in browser (set up the exact matchup via `javascript_tool`, not just "it looks right in the UI")
- [ ] PvP: extract the touched function(s) from `server.js` into a scratchpad module, assert exact expected output — don't skip this because the single-player logic "should be the same," server.js is a fully independent implementation
- [ ] Update battle-logic and/or pokemon-data skill with anything non-obvious you hit (a new pattern, a new gotcha) — if nothing new was learned, no update needed, don't pad the skill file for its own sake
