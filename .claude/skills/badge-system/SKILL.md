---
name: badge-system
description: Checklist for adding a new badge to the 我的寶可夢 badge system after the user drops a new image into 週排行榜＿徽章/. Triggers on "新增徽章", "加徽章", "週排行榜＿徽章", or the user saying they added a new badge file.
---

# Adding a new badge — checklist

The badge system (added 2026-07-17, extended 2026-07-18) is deliberately **registry-driven**: `server.js`'s `BADGES` object is the single source of truth, and both the GM admin panel (`public/admin.html`) and the pet display (`public/tamagotchi.html`) read from it dynamically — neither hardcodes a badge list. This means adding a badge is a 2-step, low-risk change. Do not add any code to admin.html or tamagotchi.html for a new badge; if you find yourself editing either of those files for this task, stop — that means the registry pattern broke somewhere and needs fixing, not working around.

There is still **no automatic awarding mechanism** (no weekly cron/settlement that detects the leaderboard #1 and assigns a badge) — every badge is assigned manually by a GM via the admin panel's "設定徽章" dropdown. Don't build automatic awarding unless the user explicitly asks for it; it's a known, deliberate gap (see project memory).

## Steps

- [ ] Find the new image in `週排行榜＿徽章/` (repo-root sibling folder, not under `public/`) — if the user didn't name the exact file, `ls` the folder and diff against filenames already copied into `public/badges/` to spot the new one
- [ ] **View the image** (Read tool) before naming anything — the visual design tells you what the badge represents (e.g. a crown + "#1 LEADER" text = champion-only; a plain Pokéball with no rank marking = general participation). Don't guess the id/name from the filename alone, past badges have been named ambiguously (`W629_首屆_冠軍徽章.png` vs `W629_首屆_徽章.png` — only the image content made the distinction obvious)
- [ ] Copy it into `public/badges/` with a clear kebab-case filename describing what it *is*, not the source filename — existing convention: `weekly-champion-01.png`, `weekly-participant-01.png`. Bump the trailing number if replacing/adding a variant of an existing type.
- [ ] Add one entry to the `BADGES` object in `server.js` (currently ~line 309): `'{id}': { name: '{中文顯示名稱}', image: '/badges/{filename}' }` — pick `id` and `name` to match what the image actually depicts, following the existing naming style (`weekly-champion`, `weekly-participant`)
- [ ] `node -c server.js`
- [ ] That's it for code. Optionally smoke-test: start a local server against the test DB, log into `admin.html`, confirm the new option appears in any user's "設定徽章" dropdown, assign it, and confirm `GET /api/pet` returns the new `badge` object for that user — but given the registry-driven design this is low-risk, a quick spot-check is enough, not a full regression pass.

## If the user asks for something beyond "just register the image"

These are out of scope for this checklist and need their own design discussion (don't silently build them):
- Automatic weekly champion/participant detection and assignment (currently 100% manual via GM)
- A user-facing "badge gallery" showing all badges ever earned (currently: one `badge_id` column on `users`, i.e. **one badge slot per user, last-assigned-wins** — not a collection)
- Badge expiry/rotation (e.g. this week's badge should replace last week's) — currently whatever the GM sets stays until manually changed
