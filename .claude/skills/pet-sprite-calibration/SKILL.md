---
name: pet-sprite-calibration
description: How to keep PMDCollab action-animation sizes visually consistent with the idle sprite, how the orbiting companion (Pichu) tracks the main pet, and the retired wearable-overlay landmark-finding methodology for 我的寶可夢. Triggers on "動作動畫大小", "小夥伴", "companion", "跳起來的圖案", "新增寶可夢" for the tamagotchi feature.
---

# Pet sprite calibration — animation scale + companion tracking

`public/tamagotchi.html`'s pet stage composites overlays (a companion sprite, action-animation sprite sheets) on top of `#pet-sprite`. Every pixel position or size here is a cross-referencing problem between **multiple different art sources drawn at different native resolutions and different poses**, and most mistakes so far have come from calibrating against the wrong reference, not from imprecise reading. Read this whole file before touching `ANIM_DISPLAY_TARGET`, `PET_ANIM`, or the companion orbit logic.

## Animation display scale (Eat/Sleep/Attack sizing)

`playPetAnim()` overlays a PMDCollab sprite-sheet frame — a **separate art source** from the idle GIF, with its own native resolution per animation per species (see `PET_ANIM` for the raw `[w,h,frames]`). Displaying these at native pixel size makes them look wildly smaller than the idle sprite (e.g. Pikachu's Sleep frame is 32×40 natively, vs. the idle GIF nearly filling the full 96×96 CSS box).

**Scale each animation independently against its own frame size — do not derive one shared scale per species.** This was tried twice and reverted both times:

- v1 was unscaled (native pixel size) → Sleep/Eat looked tiny next to idle.
- v2 computed **one scale per species** from PMDCollab's own Idle-frame size, reasoning that "PMDCollab keeps a consistent character scale across its own rig, so one multiplier should work for Eat/Sleep/Attack too." This is theoretically tidy but wrong in practice: PMDCollab's Attack frame canvas is genuinely 40–75% bigger than its Idle frame (room for an outstretched arm/effect, not a bigger character), so the *same* multiplier that makes Idle-equivalent look right makes Attack noticeably bigger than Sleep, and neither one reliably lands close to the real 96×96 idle box. The user reported oversized Attack and undersized Sleep as two *separate* bugs before this was diagnosed — both were the same root cause.

**Current (v3, correct) approach**: compute `currentAnimScale = ANIM_DISPLAY_TARGET / Math.max(w, h)` **fresh for every `playPetAnim()` call**, using that specific animation's own `[w,h]` from `PET_ANIM`. `ANIM_DISPLAY_TARGET = 88`, tuned empirically (not derived) by triggering Eat/Sleep/Attack on Pikachu and comparing `getBoundingClientRect()` output against the idle sprite's `96×96`:

```
Eat    [24,48] → 44×88
Sleep  [32,40] → 70×88
Attack [80,80] → 88×88
idle (unrelated to this formula, fixed CSS box) → 96×96
```

All three land in the 70–96px range now, visually close to each other and to idle — this is what "look like they're about the same size" actually requires, not literal PMDCollab-rig fidelity. The trade-off: switching between animations on the *same* pet produces a small visible size jump at the switch instant (since each animation targets 88px independently rather than sharing a species-derived multiplier) — this reads as normal "different pose, different silhouette" variation, not as a bug, and is far less noticeable than one animation being persistently much smaller than idle.

If `ANIM_DISPLAY_TARGET` needs retuning later (e.g. after adding a species whose animations still look off), don't derive it mathematically — trigger the animation, read `document.getElementById('pet-sprite').getBoundingClientRect()`, and adjust the constant until it's close to `96`. Empirical testing caught both of the wrong turns above; formula-only reasoning didn't.

## Preloading (avoid the "pet disappears" bug)

`playPetAnim()` must **preload** the PMDCollab sprite-sheet URL with a throwaway `new Image()` and only swap `#pet-sprite`'s `src` to the transparent placeholder inside that image's `onload` callback. If you swap to the transparent placeholder immediately and let `background-image` load asynchronously in the background, there's a window — invisible on a fast connection, very visible on a slow one — where the transparent placeholder is showing and the background sprite sheet hasn't painted yet, making the pet appear to vanish entirely. This shipped as a real bug (reported as "餵食的畫面沒有出來，寶可夢會不見") masked for a while by an unrelated bug where the "transparent" placeholder was accidentally opaque white — once that one was fixed, the underlying load-race became visible as true invisibility instead of a wrong-color flash. On `onerror`, abandon the animation attempt entirely and leave the idle sprite untouched — never leave the pet mid-transition with no visible image.

## Companion sprite (Pichu, orbiting)

`startCompanion()` renders a small 16×16-native pixel-art Pichu (`PICHU_COMPANION_FRAMES`, 2 bounce frames) that orbits `#pet-sprite` continuously via `requestAnimationFrame`.

**Critical gotcha, already hit once**: `#pet-sprite` has `transition:left 1.8s ease-in-out, top 1.8s ease-in-out` for smooth walking. That means `img.style.left`/`img.style.top` (the inline style *attribute*) update **instantly** the moment JS sets a new target, but the actual **painted position** eases toward that target over 1.8 seconds. If the orbit loop reads `parseFloat(img.style.left)` as the pet's "current" position, it's actually reading the *end-of-walk target*, not where the pet visually is right now — for up to 1.8s after every walk step, the companion orbits a point the pet hasn't reached yet, and the two visibly drift apart (confirmed by screenshot: companion ended up on the opposite side of the room from the pet). **Always read position via `img.getBoundingClientRect()`, converted into stage-local coordinates (`rect.left - stageRect.left`), never via `img.style.left`/`top` directly**, whenever something needs the pet's true current on-screen position while `#pet-sprite` might be mid-transition. This applies to any future feature that needs to track the pet's live position, not just the companion.

Bonus effect of using `getBoundingClientRect()`: it also reflects the pet's *current rendered size* (post `transform:scale()`), so the orbit radius automatically stays proportional even while an Eat/Sleep/Attack animation has temporarily resized `#pet-sprite` — no separate handling needed for that case.

Asset source: `Rangi42/polishedcrystal` (an open-source Pokémon Crystal romhack disassembly on GitHub), `gfx/minis/{species}.png` — these are the game's own tiny "mini sprite" icons (16×16 per frame, 2 frames stacked as 16×32), used in-game for the Pokédex/party menu. They ship as flat grayscale (4-shade Game Boy Color palette: 0/85/170/255), not colorized to the species' real colors — recolor manually (map the 4 gray levels to species colors, `255→transparent`) before using, or the sprite will just look like a monochrome menu icon rather than a recognizable Pichu. The repo has no explicit LICENSE file; treated the same as this project's other non-formally-licensed fan Pokémon sprite sources (PokeAPI/Showdown/PMDCollab) — fetch/derive with a visible attribution line, consistent with existing practice, not a novel exception.

## Retired: wearable overlay landmark-finding (kept for reference only)

The pet-wearables feature (glasses/hats tracking eye position) was built, calibrated through three rounds of increasingly-correct fixes, and then **abandoned by explicit user request 2026-07-19** ("我放棄裝扮了") in favor of the companion sprite above — not because the methodology was unsound, but because pixel-perfect landmark tracking on a continuously-animating multi-frame GIF has an inherent precision ceiling that wasn't worth continuing to chase. All wearable code (`WEARABLE_SVG`, `WEAR_ANCHORS`, `WEARABLE_SLOTS`, shop wearable category, `renderWearLayers`/`syncWearPositions`) was removed from both `server.js` and `public/tamagotchi.html`.

If a future request revives per-landmark overlays (wearables, or something else that needs to track a specific point on the sprite), the methodology below is still correct and worth reusing rather than rediscovering:

1. **Calibrate against what's actually displayed, never a substitute.** `#pet-sprite`'s primary image is the *animated* GIF (PokeAPI Gen5 B/W or Showdown), not the static PNG fallback — these are different art assets at different native resolutions (Pikachu: static 96×96, animated GIF natively 50×46) stretched into the same 96×96 CSS box. The first wearables attempt calibrated against the static PNG and was wrong for all 13 species as a result; two rounds of "make the coordinates more precise" fixes didn't help because the underlying reference image was wrong, not the precision. Build the true reference by fetching the animated GIF, `seek(0)`, and resizing to exactly `(96,96)` with `Image.NEAREST` — measure coordinates on *that* image.
2. **Grid-overlay + crosshair-verify, don't eyeball.** Render the 96×96 reference at 10×+ zoom with a pixel grid every 8px, read the landmark position off the grid, then draw a crosshair at the candidate coordinate and re-view zoomed in before committing — this catches the multi-pixel errors that pure eyeballing misses.
3. **Mirroring**: `#pet-sprite` gets `scaleX(-1)` when the pet walks left (`facingLeft` variable, applied via `applySpriteTransform()`). Any anchor coordinate measured on the default right-facing image needs `mirroredAx = facingLeft ? (96 - ax) : ax` wherever it's used.
4. Automated dark-pixel clustering (to auto-detect eyes) was tried and produced too much noise — it picks up outline strokes as readily as pupils. Manual grid-reading with crosshair verification was more reliable for sprites this small.
