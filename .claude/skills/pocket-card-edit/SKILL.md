---
name: pocket-card-edit
description: Fast-path checklist for changing an EXISTING real card's attack/ability/trainer effect in Pocket TCG (public/pocket.html + server.js's POCKET_CARD_OVERRIDES/ATTACK_EFFECTS/TRAINER_EFFECTS/ABILITY_EFFECTS). Use this BEFORE writing code when the request names a real card + set (e.g. "A1 百變怪", "B1a Ditto", a card id like B3-147) and wants its cost/HP/text/behavior changed. For deep architecture history and past-bug writeups, see the pocket-tcg skill — this one is the short procedural version to move fast on the common case.
---

# Pocket TCG card-edit fast path

This is the condensed, do-this-now version of the much larger `pocket-tcg` skill.
Read that one for history/rationale; read this one when you just need to make a change quickly.

## 0. Run this first, every time, no exceptions

```
node scripts/verify.js
```

The "Pocket TCG override/effect-table integrity" section (added 2026-08-23) automatically
checks: every `ATTACK_EFFECTS` key is reachable by some card's **live, post-override**
`attack.effect` text; every `TRAINER_EFFECTS` key is a real card id; every
`ABILITY_EFFECTS` key matches a printed-or-added ability name; every
`POCKET_CARD_OVERRIDES` entry's `attackCost`/`attackEffect`/`modifyAbility` name
actually exists on some printing of that card. This exists because it caught a real,
live, silent bug on its first run: two `POCKET_CARD_OVERRIDES['Ditto'].attackEffect`
entries rewrote `atk.effect` to new text at load time, but the `ATTACK_EFFECTS` handler
keyed on the *old* text was never updated — so `ATTACK_EFFECTS[atk.effect]` returned
`undefined` and Ditto's "Copy Anything"/"Copy a Friend" silently dealt 0 damage with none
of their logic, with no crash and no error anywhere. **Run it after every override/effect
edit, not just at the end** — it's instant and it directly targets the failure mode this
whole task type keeps producing.

## 1. Figure out which of the four mechanisms you need

| Change | Where |
|---|---|
| New card that doesn't exist in the real TCG | Not this skill — that's a from-scratch Fan Made card, different process |
| A **Pokémon**'s HP / retreat cost / Chinese name / new-ability-on-blank-card / rewrite-an-existing-ability's-condition / one attack's energy cost / one attack's effect text | `POCKET_CARD_OVERRIDES[english name]` — see field table below |
| A **Trainer** (Item/Supporter/Tool/Stadium) card's effect text or logic | `POCKET_CARD_OVERRIDES[name].effect`/`.effect_zh` for text; `TRAINER_EFFECTS[card id]` for logic |
| An attack's *logic* (not just its cost/text) | `ATTACK_EFFECTS[exact attack.effect text]` |
| An ability's *logic* | `ABILITY_EFFECTS[ability name]` |

`POCKET_CARD_OVERRIDES` is keyed by the card's **English `name`**, and applies to
**every printing/rarity of that name at once** (the load-time loop in `server.js` sweeps
all of `POCKET_CARDS`) — you never need to special-case A1 vs B1a versions of the same
species unless the two printings have different attack *names* (then use separate
entries inside the `attackEffect`/`attackCost` arrays, keyed by each attack's own name).

### `POCKET_CARD_OVERRIDES` field menu

```js
'Card English Name': {
  hp: 90,                                    // flat HP override
  retreat: 1,                                 // flat retreat-cost override
  name_zh: '新中文名',                          // display-name rename only (name key stays English)
  addAbility: { type:'Ability', name, name_zh, effect, effect_zh },   // card has NO printed ability
  modifyAbility: { name, effect, effect_zh }, // card ALREADY has this ability — name/name_zh stay printed, only text/condition changes
  attackCost: { name: 'Attack Name', cost: ['Darkness','Colorless'] },
  attackEffect: [ { name: 'Attack Name', effect: '...', effect_zh: '...' }, ... ],  // rewrite an attack's own effect text
  effect: '...', effect_zh: '...',            // Trainer cards only — top-level, not nested
}
```

## 2. The two things that WILL bite you if skipped

**a) `attackEffect` changes the dictionary key you must use.** If you write an
`attackEffect` override, the card's *live* `atk.effect` becomes the NEW text at load
time — permanently, for every printing matching that name. Any `ATTACK_EFFECTS` handler
for that attack must be keyed by the **new** text, not the real printed text. If you're
adding brand-new logic for the changed attack, write the `ATTACK_EFFECTS` entry with the
override's new text as the key from the start. If a handler already existed under the
old printed text, rename its key — don't leave the old one lying around (step 0's check
catches this automatically now, but know why it exists).

**b) Client-side mirrors drift silently — they are hand-written duplicates of server
logic that nothing keeps in sync.** If your change touches attack cost, retreat cost, or
anything `public/pocket.html` displays/gates independently of what the server computes,
check these specific functions and update them together, not just the server side:
- `pocketEffectiveAttackCostClient` (attack-cost display/afford-check mirror)
- `pocketComputeRetreatCostClient` + `pocketClientRetreatModifier` (retreat — there are
  historically been **two** separate mirrors of the same passive that drifted from each
  other; grep both, don't assume fixing one fixed the other)
- `pocketViewFor(G, role)`'s `you: {...}` object in server.js — this is a **curated
  whitelist**, not a full-object broadcast. A new per-side flag your logic reads
  client-side (e.g. a "this turn" discount/buff field) must be added here explicitly or
  the client will silently see `undefined` forever.

There is no automated check for (b) yet — it requires actually exercising the UI. If your
change affects displayed cost/retreat/afford-gating, manually diff the client mirror
against the server logic you just wrote before calling it done.

## 3. Testing without re-deriving extraction boilerplate

`scripts/pocket-extract.js` exports the string/comment-aware extraction helpers this
whole task type needs (a naive `{`/`}` depth counter breaks on `{W}`-style energy
placeholders inside card text — this bit a prior session and cost real time rediscovering
the fix). Require it from a scratch test file instead of rewriting a brace matcher:

```js
const { extractBlock, extractObjLiteral, extractFn, extractTopLevelKeys,
        liveAttackEffectTexts, POCKET_CARDS, cardById } = require('/Users/mike/Desktop/AI_Claude_code_Projects/pokemon_leisure_games/scripts/pocket-extract');

// eval a plain-data override table:
const OV = extractObjLiteral('POCKET_CARD_OVERRIDES');

// pull one handler table and check a specific key resolves + fires as expected:
const ATTACK_EFFECTS = eval('(' + extractBlock('ATTACK_EFFECTS') + ')');
const fn = ATTACK_EFFECTS["<new override text>"];
console.log('found:', !!fn);
let ctx = { side: {...}, oppSide: {...}, defender: {...}, G: {...} };
fn(ctx);
console.log(ctx.needsChoice, ctx.rawDamage);
```

For anything that needs the *real* end-to-end WS flow (a pick_move/pick_target
resolution chain, a checkup trigger), boot a scratch server —
**`PORT=3999 node server.js`**, never bare `node server.js`. The project's actual dev
server is normally already bound to port 3000; booting without an explicit port and
trusting a subsequent `curl`/fetch can silently hit that stale pre-edit process via
`EADDRINUSE` fallback and produce a false "still broken" or false "works" result. Check
for `EADDRINUSE` in the boot output before trusting anything you test against it. Kill
the scratch process when done.

## 4. Button-triggered abilities need a client-side whitelist entry too

If `addAbility`/an `ABILITY_EFFECTS` entry gives a card a *button-triggered* ability
(as opposed to an automatic checkup/passive one), it also needs its `name` added to
`public/pocket.html`'s `ABILITY_NAMES_SUPPORTED` Set, or the ability button silently
never renders (`renderPokeSlot()` gates the button on `ABILITY_NAMES_SUPPORTED.has(name)`
— missing entry = no crash, just an invisible feature). Passive/checkup abilities don't
need this.

## 5. Make sure the changed field is visibly marked somewhere — image overlay OR text-list highlight

Every override field needs a visible "this was changed" marker, or the user sees correct
behavior in battle but the card-detail view looks untouched and reports it as still
broken. Two different mechanisms depending on whether the field has fixed printed
real estate to draw over:

- **hp / addAbility / modifyAbility / attackCost** change something at a fixed position
  on the printed card art → get a pixel-calibrated overlay box in
  `buildCardPatchOverlay()` in `public/pocket.html`. Coordinates are measured per
  template shape (see `pocket-tcg` skill for the full measurement method) — don't reuse
  another field's box coordinates for a new field, and don't skip this step reasoning
  "the plain text below the image already shows the right value" — flagged insufficient
  before for attackCost (「圖案上招式能量消耗的部分沒修到」).
- **attackEffect / anything whose text area has no fixed position or length** (varies
  per attack, per template) → don't try to calibrate an image overlay for it. Instead
  highlight the field in the **text list already rendered below the image** — e.g.
  `attackEffect`'s fix (2026-08-23) checks `card._patch?.attackEffect` against each
  attack's name in `showCardDetail`'s attack map and adds a `.attack-patched` class +
  "⚠️已修改" badge to just that attack's block. Also flagged insufficient once already
  when skipped entirely — a whole-card gold border (`.has-patch`) doesn't say *which*
  attack changed, especially on a multi-attack Pokémon (「圖片沒標示修改的部分」).

Bottom line: don't ship an override field with only the generic `.has-patch` border and
call it done — check whether it needs the pixel-overlay treatment or the text-list
highlight treatment, and do one of them.

## 6. Commit + push

Skill/script edits and the game-logic change they're about go in the **same commit**,
same push (this repo's `main` has no path filtering — every push redeploys the whole
Zeabur app, and a separate skill-only push right after a code push just doubles
redeploys for nothing). Expect a ~180s pre-push cooldown hook between pushes; wait it
out (`ScheduleWakeup`), don't `--no-verify` it without being told to.
