---
name: ui-rendering
description: Use when working on rendering/DOM updates, CSS/visual design, sprites/animations, popups and modals, mobile/responsive layout, or badges (type/status/buff/ability). Triggers on requests like "畫面顯示問題", "手機版跑版", "動畫怪怪的", "圖片沒更新", "新增彈窗", "CSS", "响应式", "特性徽章".
---

# UI & Rendering (介面相關)

## Render entry points

`renderBattle()` → `renderSide('player'|'cpu', poke, deck, activeIdx)` (×2) + `renderActions()` + `renderHand()`. Called after nearly every state change — single-player calls it directly and synchronously; PvP calls it inside the WS `case 'update':`/`case 'battle_start':` handlers after `applyServerState(sG)` copies server state into the client's local `G` object. `renderSide` is the one function that touches sprite, type/status/ability badges, HP bar, and buff tags for one side's active card — if a new per-Pokémon UI element needs to show up on the battle card, it goes here (and its 4-file twin).

## Design tokens

`:root` CSS custom properties, same values across all files: `--bg:#07091a` (near-black), `--surface:rgba(255,255,255,0.05)`, `--border:rgba(255,255,255,0.10)`, `--text:#e8eaf6`, `--muted:#7986cb`. Accent/gold `#f8d030` used for anything "important/positive" (active selection, victory, ability badges use a purple `#ce93d8`/`rgba(186,104,200,...)` instead to stay visually distinct from buff tags). Traditional Chinese throughout (`lang="zh-TW"`). Animated `<canvas id="stars">` background, self-invoking IIFE near the top of each `<script>` block.

## The sprite `_pokeRef` gotcha — read before touching `setSprite`

`setSprite(el, id, poke)` decides whether to reload the sprite `<img>` (restarting its GIF, replaying the entrance animation) or leave it alone. This has been the source of two separate bugs already:

1. **Single-player**: switching between two *different* Pokémon instances of the *same species* (rare, but reachable via 通關獎勵/pick-a-defeated-enemy-mon) didn't reset the sprite, because the original guard only compared `dataset.pokeId` (species id) — two different objects with the same species id looked "unchanged." Fixed by tracking object identity (`el._pokeRef === poke`) instead.
2. **That fix then broke 瘋狂博士 (mad-scientist)**: its transform mutates a Pokémon **in place** (same object reference, new species `id`) — so `el._pokeRef === poke` stayed true even though the species changed, and the sprite silently kept showing the old artwork.

Current (correct) state, and **do not simplify this back to a single check**:
- Single-player: `if (el._pokeRef === poke && el.dataset.pokeId === String(id)) return;` — both must match to skip reload (same instance *and* same species).
- PvP: `if (el.dataset.pokeId === String(id)) return;` — id-only. PvP state is freshly deserialized from WebSocket JSON on every single update, so `poke` is never the same object twice; comparing object identity there is meaningless overhead, not a safety net. (PvP rosters also can't contain duplicate species — see pokemon-data skill — so id-only comparison has no edge case to worry about there.)

If you add a *third* place that decides "is this really the same Pokémon still on screen," use whichever of these two patterns matches the engine, don't invent a third approach.

## HP bar — animate on damage, snap on switch/KO

`.hp-fill` has no transition by default; a `.animated` class adds `transition: width .5s, background-color .4s`. `updateHp()` (called mid-attack, for the actual damage-over-time visual) adds `.animated` before changing width. `renderSide()` (called on any full re-render — switch, KO, initial reveal) *removes* `.animated` first, so the bar snaps instantly instead of visibly "draining" from the *previous* Pokémon's HP to the new one's (this exact bug — HP bar tweening across a species swap and looking like phantom damage — was reported and fixed 2026-07-01). PvP doesn't have a separate `updateHp`; it diffs `prevCur` vs new `cur` for the *same still-active* Pokémon (idx unchanged) inside the `case 'update':` handler to decide whether to add `.animated` before `renderBattle()` runs.

## Popups/modals

Pattern: a single reusable `#bench-popup` (or `#xxx-modal`) DOM node, repositioned/repopulated per-invocation rather than creating new elements each time. All popups are `position: fixed` (viewport-relative, not affected by page scroll) — **never add a `+ scrollY` offset to a fixed-position element's coordinates**, `getBoundingClientRect()` is already viewport-relative. (PvP's bench popup had exactly this bug — an erroneous `+ scrollY` that mispositioned it on any scrolled/mobile page — fixed 2026-07-02.) Clamp both horizontally *and* vertically against `window.innerWidth`/`innerHeight`; only horizontal clamping existed for a long time before anyone noticed the vertical gap. `.bench-popup` also carries `max-height:calc(100vh - 16px); overflow-y:auto;` as a last-resort safety net.

New modals follow the `#discard-modal`/`#trade-modal`/`#switch-confirm-modal` visual pattern: `.discard-inner` container, `.btn-modal-ok`/`.btn-modal-cancel` buttons. Reuse `renderSelCard()` (single-player) or the local per-file equivalent for any "grid of Pokémon cards to pick from" UI — the 瘋狂博士 2-step picker and the team-select screen both already share it.

## Battle log + hand: sticky sidebars on desktop, full-screen popups on mobile (2026-07-05)

Both `#battle-log` (log messages) and `#hand-panel` (trainer-card hand) exist as `position:sticky` side panels on desktop but become tap-to-open full-screen overlays under `@media (max-width:900px)` — reusing the same `position:fixed;inset:0;display:none` / `.open→display:flex` modal pattern as `#warn-modal`/`#mega-cutscene-modal`, rather than a bespoke mobile-only widget. This replaced an earlier mobile layout where the log was squeezed into a permanently-visible ~90px scrolling strip and the hand panel expanded *inline* in the page flow when tapped — both required scrolling the whole page to reach/read, which is what prompted the redesign ("每次用小螢幕看手牌或log都要一直上下滑動").

**Structure**: `#battle-log` itself stays exactly as-is functionally (still just the scrolling message list that `log()`/`log.push()` prepends into, `flex-direction:column-reverse` unchanged) — it's now wrapped in a `#log-drawer` container that owns the toggle button (`#log-drawer-btn`, hidden on desktop via `display:none`, shown on mobile) and a close button (`#log-drawer-close`). `#hand-panel` already had a toggle button (`#hand-drawer-btn`/`toggleHandDrawer()`) from before this change — that stays; only what "open" *means* on mobile changed (fixed overlay instead of inline expand), plus a new `#hand-panel-close` button was added inside it.

**Close-button visibility is state-driven, not just CSS-gated by viewport** — this bit if you get it wrong: `#hand-panel-close` is a *descendant* of `#hand-panel`, so `#hand-panel.open #hand-panel-close { display:block; }` works with a plain descendant selector. But `#log-drawer-close` is a *preceding sibling* of `#battle-log` (button comes before the log div in the DOM, so it can render at the top of the popup), and CSS sibling combinators can't select backwards — so `toggleLogPanel()` explicitly toggles `.open` on `#log-drawer-close` itself (a third `classList.toggle`, alongside the button and the log div), and the CSS rule is `#log-drawer-close.open { display:block; ... }`. If you add a similar toggle-panel-with-corner-close-button pattern and the close button ends up before its panel in markup, you need this same explicit third toggle — a purely CSS-driven approach silently leaves the button permanently invisible (checked via `getComputedStyle(...).display` during testing, not just eyeballing a screenshot).

**Testing this without a real phone/resizable browser window**: the `resize_window` MCP tool does not reliably resize the actual rendered viewport in this environment (window stayed at its original size despite a "success" response, confirmed via `window.innerWidth` after the call). The reliable way to test `@media` rules here is to extract the real `@media (max-width:900px) { ... }` block's contents straight out of the page's own `<style>` tag via JS (regex/brace-counting to find the matching close-brace) and re-inject it as an unconditional `<style>` override — this exercises the *actual* shipped CSS rather than a hand-retyped approximation of it, so it also catches copy-paste mistakes between the real file and a test snippet.

## Badges on a Pokémon's card

Type badge, status badge (`.status-tag`), buff tags (`.buff-tag`), and ability badge (`.ability-badge`, `✨ name`, added 2026-07-02) all live on the same card and are independently populated in `renderSide`. When adding a new per-Pokémon indicator, check whether it needs to appear in all *three* places data is shown: the live battle card, the bench/info popup, and the team-select/mad-scientist selection cards — abilities originally only got added to the battle card and had to be retrofitted into the other two after a user report that "abilities aren't visible."
