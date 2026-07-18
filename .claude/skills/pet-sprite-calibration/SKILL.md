---
name: pet-sprite-calibration
description: How to precisely locate landmarks (eyes, and later head/hands/feet) on 我的寶可夢's pet sprites for wearable overlays, and how to keep PMDCollab action-animation sizes visually consistent with the idle sprite. Triggers on "寶可夢素材比例", "眼鏡位置", "服裝對齊", "動作動畫大小", "新增穿搭", "新增寶可夢" for the tamagotchi feature.
---

# Pet sprite calibration — landmark anchors + animation scale

`public/tamagotchi.html`'s pet stage composites overlays (wearable accessories, action-animation sprite sheets) on top of `#pet-sprite`. Every pixel position or size here is a cross-referencing problem between **multiple different art sources drawn at different native resolutions**, and every mistake so far has come from calibrating against the wrong source image, not from imprecise reading. Read this whole file before touching `WEAR_ANCHORS`, `PET_ANIM_SCALE`, or adding a new species/wearable.

## The one rule that matters most: calibrate against what's ACTUALLY displayed, never a substitute

`#pet-sprite`'s primary image is `spriteUrls(sp).animated` — an **animated GIF** (PokeAPI Gen5 black-white for the 10 legacy species, Showdown's `sprites/ani/{slug}.gif` for the 3 newGen species). The `.static` PNG is only a fallback shown on `onerror`. **These two images are not the same artwork at two sizes — they're different art assets with different poses, different padding, and critically different native resolutions**, e.g. Pikachu's static PNG is 96×96 but the animated GIF is natively 50×46. Both get force-stretched into the same `96px×96px` CSS box, but *what fills that box* is completely different between the two sources.

**The first version of `WEAR_ANCHORS` was calibrated against the static PNG** (open the file, measure eye coordinates, done — looked reasonable in isolation) **and was wrong for every single species**, because the game shows the animated GIF 99% of the time. This was found and fixed 2026-07-18 after two rounds of user bug reports with reference screenshots — the first "fix" attempt improved anchor *precision* but didn't address that the anchors were measured against the wrong image entirely, so the bug persisted. Don't repeat this: **any pixel coordinate you derive must be measured on the exact image object the CSS box actually renders**, never a sibling asset that merely looks similar.

### How to get the "actually displayed" reference image for a species

```bash
# legacy species (id in PET_SPECIES without newGen:true) — PokeAPI Gen5 B/W animated
curl -s -o out.gif "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/{id}.gif"
# newGen species (newGen:true, has a slug) — Showdown animated
curl -s -o out.gif "https://play.pokemonshowdown.com/sprites/ani/{slug}.gif"
```
Then, in Python/PIL: open the GIF, `seek(0)` for frame 0, convert to RGBA, and **resize to exactly (96, 96) with `Image.NEAREST`** — this reproduces exactly what `width:96px;height:96px` CSS does to a non-96×96 source, non-uniformly stretching both axes independently if the native aspect ratio isn't 1:1. Measure all coordinates on *this* resized image, in its 0–96 coordinate space — that's the same space `img.style.left/top` and `WEAR_ANCHORS` use, since `#pet-sprite` itself is never scaled by anything other than this fixed CSS box (the `transform:scale()` from action animations is a separate, later concern — see below).

## Finding landmark coordinates (eyes today, potentially head/hands/feet later)

Manually eyeballing a small sprite is unreliable — the two prior attempts that used "look at an 8×-zoomed grid overlay and estimate" were each off by several pixels, small in absolute terms but very visible on a 96px sprite. The reliable process:

1. Build the 96×96-resized reference image per species (above).
2. Render it at 10×+ zoom with a pixel grid overlaid every 8px and coordinate labels every 16px (a `PIL.ImageDraw` script — see git history around 2026-07-18 for the exact snippet, or just write a fresh one, it's ~20 lines).
3. Read the landmark position directly off the grid — for eyes, look for the darkest/highest-contrast small cluster in the upper half of the character silhouette. Automated dark-pixel clustering was tried and produced too much noise (it also picks up the character's outline stroke, not just eyes) — direct visual reading against a labeled grid is more reliable than clustering for sprites this small and this stylistically inconsistent species-to-species.
4. **Verify before committing**: draw a crosshair at your candidate coordinate directly onto the reference image and re-view it zoomed in. If it doesn't sit visibly on the landmark, adjust and re-render — don't trust a single read. This verify-by-rendering step is what catches the small errors that pure grid-reading misses.
5. For 3/4-profile species where only one eye is visible (Squirtle, Totodile, Eevee), anchor on that single visible eye rather than an estimated bilateral center — the symmetric glasses icon still reads fine placed there.

Current `WEAR_ANCHORS` (`wear-face`, i.e. eye-center, in 96×96 display-space coordinates) — re-derive with the process above if you add a species, don't extrapolate from these by "it looks similar to X":

| id | name | anchor | id | name | anchor |
|---|---|---|---|---|---|
| 1 | Bulbasaur | [23,53] | 25 | Pikachu | [37,30] |
| 4 | Charmander | [25,20] | 722 | Rowlet | [34,32] |
| 7 | Squirtle | [36,26] | 906 | Sprigatito | [40,44] |
| 152 | Chikorita | [21,57] | 909 | Fuecoco | [38,37] |
| 155 | Cyndaquil | [26,42] | 92 | Gastly | [42,35] |
| 158 | Totodile | [37,44] | 132 | Ditto | [40,38] |
| | | | 133 | Eevee | [30,45] |

If you re-add head/neck wearable slots later (removed 2026-07-18 to de-scope while eye-tracking was being fixed — see server.js's `SHOP_ITEMS` history), find "head-top" and "neck" landmarks the exact same way: build the 96×96 reference, grid it, read + verify with a crosshair. Do not reuse the old static-PNG-based head/neck coordinates that existed before this rewrite — they have the same wrong-source bug the eye anchors had.

### Mirroring

When the pet walks left, `#pet-sprite` gets `scaleX(-1)` (tracked in the `facingLeft` variable, applied via `applySpriteTransform()`). Anchor coordinates were measured on the *unmirrored* (right-facing default) image, so any code reading `WEAR_ANCHORS` must mirror the X coordinate when `facingLeft` is true: `mirroredAx = facingLeft ? (96 - ax) : ax`. Both `syncWearPositions()` (main stage) and `setupVisitSprite()`'s `syncWear()` (visit-friend dual view) need this — it's easy to add a third sprite-rendering call site later (e.g. a species picker preview) and forget the mirror term entirely, producing the exact "glasses on the wrong side when facing left" bug that shipped once already.

## Animation display scale (Eat/Sleep/Attack sizing)

`playPetAnim()` overlays a PMDCollab sprite-sheet frame — a **third, independent art source** from either PokeAPI/Showdown image, with its own native resolution per animation per species (see `PET_ANIM` for the raw `[w,h,frames]`). Displaying these at native pixel size makes them look wildly smaller than the idle sprite (e.g. Pikachu's Sleep frame is 32×40 natively, vs. the idle GIF nearly filling the full 96×96 box) — reported by the user as "睡覺的圖案跟原本活動中的圖案的大小差太多了".

**The fix is a per-species `transform:scale()` factor, not a per-animation one.** PMDCollab's own rig keeps a species' character drawn at a consistent internal scale across all its animations — Attack's frame is bigger than Idle's because the motion needs more canvas (an outstretched arm, an effect), not because the character itself is bigger. So: derive **one** scale factor per species by comparing PMDCollab's own Idle frame to the target display size, then apply that same factor to Eat/Sleep/Attack for that species. Do not compute a fresh scale per-animation from that animation's own frame size — that was the first (wrong) approach taken here and it produces inconsistent sizing across a single species' own animations, since bigger-canvas animations like Attack would get scaled *down* relative to Idle purely because their frame happens to be bigger, which is backwards.

### Deriving the per-species scale

1. Fetch PMDCollab's `Idle-Anim.png` for the species (`https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite/{dex4}/Idle-Anim.png`), crop to frame 0 using the `[w,h]` from `AnimData.xml`'s `<Name>Idle</Name>` entry.
2. `TARGET = 90` (the idle GIF's content, once stretched to the 96×96 box, fills nearly the entire box across all 13 species — content bbox width/height typically 74–96px — so 90 is a reasonable "how big should the character appear" reference, not a coincidence with the CSS box size).
3. `scale = TARGET / max(pmd_idle_frame_w, pmd_idle_frame_h)` — use the **frame** dimensions (the `[w,h]` from AnimData.xml), not a content-cropped bbox. An earlier attempt matched *content*-bbox-to-content-bbox between PMDCollab idle and the display-idle GIF and produced scale factors of 3–6× — technically matching pixel-for-pixel character size, but PMDCollab's idle frames have so much internal padding relative to their tiny character that this wildly over-amplifies once applied to Attack's already-bigger frame (Attack frames ended up rendering at 150–200px, dwarfing the room). Frame-size-based calibration avoids this because it doesn't try to cancel out PMDCollab's own padding conventions.
4. Cap the final displayed size: `finalScale = min(scale, ANIM_SCALE_CAP / max(frame_w, frame_h))` where `ANIM_SCALE_CAP = 130` — a safety ceiling so a species/animation combo with an unusually large frame doesn't visually dominate the room regardless of its calibrated scale. Tune this constant by eye if animations still look too big/small after adding a new species; it's a deliberately coarse safety net, not a precision instrument.

Current `PET_ANIM_SCALE` (raw, before the cap is applied at runtime):
```
1: 2.25   4: 2.25   7: 2.81   152: 1.88  155: 2.81  158: 1.88
25: 1.61  722: 2.81 906: 1.88 909: 2.81  92: 1.61   132: 2.81  133: 2.81
```

**Known limitation, not a bug to chase further**: the idle GIF itself is a multi-frame animation (30–84 frames per species) with visible pose drift frame-to-frame (confirmed by sampling Pikachu's GIF at 4 points — content bbox shifted by several px between frames). `WEAR_ANCHORS` is calibrated against frame 0 only. Glasses will therefore have some inherent jitter relative to the eye as the idle GIF plays through its loop — this is a real constraint of overlaying a static-positioned accessory on a continuously-animating multi-frame GIF, not something fixable by better coordinate-reading. If this jitter is ever reported as a problem, the honest options are (a) accept it as a known trade-off (current default), (b) pause the GIF on a single frame via canvas-based frame extraction instead of using `<img src>` directly (real engineering effort, changes how the idle sprite renders entirely), or (c) switch wearables to only render during moments the pet is provably static (e.g. sleeping) — don't attempt a quick fix without picking one of these deliberately.

## Preloading (avoid the "pet disappears" bug)

`playPetAnim()` must **preload** the PMDCollab sprite-sheet URL with a throwaway `new Image()` and only swap `#pet-sprite`'s `src` to the transparent placeholder inside that image's `onload` callback. If you swap to the transparent placeholder immediately and let `background-image` load asynchronously in the background, there's a window — invisible on a fast connection, very visible on a slow one — where the transparent placeholder is showing and the background sprite sheet hasn't painted yet, making the pet appear to vanish entirely. This shipped as a real bug (reported as "餵食的畫面沒有出來，寶可夢會不見") masked for a while by an unrelated bug where the "transparent" placeholder was accidentally opaque white — once that one was fixed, the underlying load-race became visible as true invisibility instead of a wrong-color flash. On `onerror`, abandon the animation attempt entirely and leave the idle sprite untouched — never leave the pet mid-transition with no visible image.

## Checklist: adding a new pet species

- [ ] Add to `PET_SPECIES` (id, name, type, `newGen`+`slug` if post-Gen-5) in both `server.js` and `public/tamagotchi.html`
- [ ] Fetch the species' actual displayed sprite (animated GIF, not static PNG — see above) and resize to 96×96 to get the true reference image
- [ ] Derive `wear-face` (eye) anchor: grid-overlay + crosshair-verify against that reference, add to `WEAR_ANCHORS`
- [ ] Fetch `AnimData.xml` for Eat/Sleep/Attack + Idle frame sizes, add to `PET_ANIM`
- [ ] Fetch PMDCollab's `Idle-Anim.png`, derive `PET_ANIM_SCALE` via `TARGET(90) / max(idle_frame_w, idle_frame_h)`
- [ ] If the species lacks `Eat-Anim.png` (no mouth — Ditto/Gastly precedent), leave `Eat` out of its `PET_ANIM` entry and add an `Idle:[w,h,frames]` entry instead so `playPetAnim`'s `table[animName] ? animName : 'Idle'` fallback has something to use
- [ ] Test in-browser: click to trigger the 30%-chance Attack animation, feed to trigger Eat, force Sleep via `playPetAnim(id,'Sleep',true)` — check glasses alignment (if equipped) and that displayed size looks comparable to idle, not wildly bigger/smaller
