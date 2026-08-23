#!/usr/bin/env node
// Automated regression checks for this repo's "must edit both engines identically"
// architecture. Run after any change to pokemon_battle.html / server.js / public/*.html.
//
//   node scripts/verify.js
//
// Exits non-zero if anything fails, so it can also be used as a pre-commit gate.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; }
function section(title) { console.log(`\n${title}`); }

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no <script> block found');
  return m[1];
}

function checkHtmlSyntax(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) { fail(`${relPath}: file not found`); return; }
  try {
    new Function(extractScript(fs.readFileSync(full, 'utf8')));
    ok(`${relPath}: syntax OK`);
  } catch (e) {
    fail(`${relPath}: ${e.message}`);
  }
}

function extractArray(text, varName) {
  const re = new RegExp(`const ${varName} = \\[[\\s\\S]*?\\n\\];`);
  const m = text.match(re);
  if (!m) throw new Error(`const ${varName} = [...] not found`);
  return eval(m[0].replace(`const ${varName} = `, ''));
}

// ── 1. Syntax ──────────────────────────────────────────────────────────────
section('Syntax checks');
checkHtmlSyntax('pokemon_battle.html');
checkHtmlSyntax('public/single.html');
checkHtmlSyntax('public/pvp.html');
try {
  execSync(`node -c ${path.join(ROOT, 'server.js')}`, { stdio: 'pipe' });
  ok('server.js: syntax OK');
} catch (e) {
  fail(`server.js: ${e.stderr?.toString().trim() || e.message}`);
}

// ── 2. single.html must be a byte-for-byte mirror of pokemon_battle.html ───
section('single.html sync');
try {
  const a = fs.readFileSync(path.join(ROOT, 'pokemon_battle.html'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'public/single.html'), 'utf8');
  if (a === b) ok('public/single.html matches pokemon_battle.html');
  else fail('public/single.html is OUT OF SYNC — run: cp pokemon_battle.html public/single.html');
} catch (e) {
  fail(`could not compare: ${e.message}`);
}

// ── 3. POKEMON array parity between the two engines ─────────────────────────
section('POKEMON data parity (pokemon_battle.html vs server.js)');
try {
  const htmlPokemon = extractArray(fs.readFileSync(path.join(ROOT, 'pokemon_battle.html'), 'utf8'), 'POKEMON');
  const srvPokemon = extractArray(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), 'POKEMON');
  if (htmlPokemon.length !== srvPokemon.length) {
    fail(`roster size mismatch: pokemon_battle.html has ${htmlPokemon.length}, server.js has ${srvPokemon.length}`);
  } else {
    ok(`both engines have ${htmlPokemon.length} Pokémon`);
  }
  let mismatches = 0;
  htmlPokemon.forEach((p, i) => {
    const q = srvPokemon[i];
    if (!q || p.id !== q.id) { mismatches++; console.log(`    id mismatch at index ${i}: ${p.id} vs ${q?.id}`); return; }
    if (JSON.stringify(p.attacks) !== JSON.stringify(q.attacks)) { mismatches++; console.log(`    attacks differ: id=${p.id} ${p.name}`); }
    if (JSON.stringify(p.ability) !== JSON.stringify(q.ability)) { mismatches++; console.log(`    ability differs: id=${p.id} ${p.name}`); }
    if (JSON.stringify(p.mega) !== JSON.stringify(q.mega)) { mismatches++; console.log(`    mega differs: id=${p.id} ${p.name}`); }
  });
  if (mismatches === 0) ok('attacks/ability/mega data identical across both engines');
  else fail(`${mismatches} field mismatch(es) between engines — see above`);
} catch (e) {
  fail(`could not compare POKEMON arrays: ${e.message}`);
}

// ── 4. TRAINERS array parity + the #1 recurring bug: stadium id missing from
//       the generic activation switch case ──────────────────────────────────
section('TRAINERS data parity + stadium activation coverage');
function checkTrainers(label, filePath) {
  const text = fs.readFileSync(path.join(ROOT, filePath), 'utf8');
  const trainers = extractArray(text, 'TRAINERS');
  const stadiumIds = trainers.filter(c => c.cat === 'stadium').map(c => c.id);
  const caseIds = [...text.matchAll(/case '(stadium-[\w-]+)':/g)].map(m => m[1]);
  const caseIdSet = new Set(caseIds);
  const missing = stadiumIds.filter(id => !caseIdSet.has(id));
  if (missing.length === 0) {
    ok(`${label}: all ${stadiumIds.length} stadium cards are wired into the activation switch case`);
  } else {
    fail(`${label}: stadium id(s) in TRAINERS but MISSING from 'case ...:' activation list: ${missing.join(', ')}`);
  }
  return trainers;
}
const htmlTrainers = checkTrainers('pokemon_battle.html', 'pokemon_battle.html');
const srvTrainers = checkTrainers('server.js', 'server.js');

const htmlIds = new Set(htmlTrainers.map(c => c.id));
const srvIds = new Set(srvTrainers.map(c => c.id));
const onlyInHtml = [...htmlIds].filter(id => !srvIds.has(id));
const onlyInSrv = [...srvIds].filter(id => !htmlIds.has(id));
if (onlyInHtml.length === 0 && onlyInSrv.length === 0) {
  ok(`both engines define the same ${htmlIds.size} unique trainer card ids`);
} else {
  if (onlyInHtml.length) fail(`cards only in pokemon_battle.html: ${onlyInHtml.join(', ')}`);
  if (onlyInSrv.length) fail(`cards only in server.js: ${onlyInSrv.join(', ')}`);
}

// ── 5. Pocket TCG: POCKET_CARD_OVERRIDES / ATTACK_EFFECTS / TRAINER_EFFECTS /
//       ABILITY_EFFECTS integrity ─────────────────────────────────────────
// These four things live entirely independently in server.js and nothing enforces
// they stay wired together — this is the exact shape of bug this section exists to
// catch (found live 2026-08-23: an attackEffect override rewrites a card's atk.effect
// at load time, but the ATTACK_EFFECTS key doing the actual logic was never updated to
// match, so `ATTACK_EFFECTS[atk.effect]` silently returned undefined and the attack
// quietly did 0 damage with none of its custom logic — no crash, no error, just a dead
// card in real play).
section('Pocket TCG override/effect-table integrity');
try {
  const pocketCardsFile = require(path.join(ROOT, 'public/pocket-cards.json'));
  const pocketCards = pocketCardsFile.cards;
  const cardById = {};
  for (const c of pocketCards) cardById[c.id] = c;
  const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // Brace matcher that skips over string/template literals and comments — a naive
  // depth-count on '{'/'}' breaks the moment a card's own effect text contains a
  // {W}/{C}-style energy placeholder (looks like an unmatched brace to a naive scanner).
  function findMatchingBrace(text, braceStart) {
    let depth = 0, i = braceStart, inStr = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
      if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 1; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }
  function extractBlock(varName) {
    const startIdx = srvSrc.indexOf(`const ${varName} = {`);
    if (startIdx < 0) throw new Error(`const ${varName} = {...} not found`);
    const braceStart = srvSrc.indexOf('{', startIdx);
    const end = findMatchingBrace(srvSrc, braceStart);
    return srvSrc.slice(braceStart + 1, end);
  }
  function extractObjLiteral(varName) {
    const startIdx = srvSrc.indexOf(`const ${varName} = {`);
    if (startIdx < 0) throw new Error(`const ${varName} = {...} not found`);
    const braceStart = srvSrc.indexOf('{', startIdx);
    const end = findMatchingBrace(srvSrc, braceStart);
    return eval(`(${srvSrc.slice(braceStart, end + 1)})`);
  }
  // Only the *top-level* keys of a handler table (2-space indent, quote-first) —
  // deliberately not `atk.effect`-anchored, since handler bodies are function values.
  function extractTopLevelKeys(body) {
    const keyRe = /^  (['"])((?:\\.|(?!\1)[\s\S])*?)\1\s*:/gm;
    let m; const keys = [];
    while ((m = keyRe.exec(body))) {
      try { keys.push(JSON.parse(m[1] === '"' ? m[0].slice(2, m[0].lastIndexOf(m[1]) + 1) : m[2])); }
      catch (e) { keys.push(m[2]); }
    }
    return keys;
  }

  const OV = extractObjLiteral('POCKET_CARD_OVERRIDES');

  // 5a. Every attack.effect text ATTACK_EFFECTS could ever see at runtime = raw
  //     pocket-cards.json text, with any attackEffect override's NEW text substituted
  //     in for the cards it patches (mirrors the load-time mutation in server.js).
  const liveEffectTexts = new Set();
  for (const c of pocketCards) {
    const ov = OV[c.name];
    const attacks = (c.attacks || []).map(a => ({ ...a }));
    if (ov && ov.attackEffect) {
      for (const ae of ov.attackEffect) {
        const a = attacks.find(x => x.name === ae.name);
        if (a) a.effect = ae.effect;
      }
    }
    for (const a of attacks) if (a.effect) liveEffectTexts.add(a.effect);
  }
  const attackEffectKeys = extractTopLevelKeys(extractBlock('ATTACK_EFFECTS'));
  const staleAttackKeys = attackEffectKeys.filter(k => !liveEffectTexts.has(k));
  if (staleAttackKeys.length === 0) {
    ok(`all ${attackEffectKeys.length} ATTACK_EFFECTS keys match some card's live (post-override) attack.effect text`);
  } else {
    fail(`${staleAttackKeys.length} ATTACK_EFFECTS key(s) match NO card's current attack.effect text (dead handler — likely stale key after an attackEffect override, or a genuine leftover to delete):`);
    staleAttackKeys.forEach(k => console.log(`    - ${JSON.stringify(String(k).slice(0, 100))}`));
  }

  // 5b. TRAINER_EFFECTS is keyed by card id — every key must exist in pocket-cards.json.
  const trainerKeys = extractTopLevelKeys(extractBlock('TRAINER_EFFECTS'));
  const missingTrainerIds = trainerKeys.filter(k => !cardById[k]);
  if (missingTrainerIds.length === 0) {
    ok(`all ${trainerKeys.length} TRAINER_EFFECTS keys are real card ids`);
  } else {
    fail(`TRAINER_EFFECTS key(s) with no matching card id: ${missingTrainerIds.join(', ')}`);
  }

  // 5c. ABILITY_EFFECTS is keyed by ability name — every key must exist as a printed
  //     ability somewhere, OR be introduced via POCKET_CARD_OVERRIDES.addAbility.
  const abilityNames = new Set();
  for (const c of pocketCards) for (const a of (c.abilities || [])) if (a.name) abilityNames.add(a.name);
  for (const name in OV) if (OV[name].addAbility?.name) abilityNames.add(OV[name].addAbility.name);
  const abilityKeys = extractTopLevelKeys(extractBlock('ABILITY_EFFECTS'));
  const missingAbilityNames = abilityKeys.filter(k => !abilityNames.has(k));
  if (missingAbilityNames.length === 0) {
    ok(`all ${abilityKeys.length} ABILITY_EFFECTS keys match a printed or added ability name`);
  } else {
    fail(`ABILITY_EFFECTS key(s) with no matching ability name (printed or addAbility): ${missingAbilityNames.join(', ')}`);
  }

  // 5d. POCKET_CARD_OVERRIDES itself — attackCost/attackEffect/modifyAbility all
  //     reference an attack/ability *name* that must actually exist on some printing
  //     of that card name, or the override silently no-ops (find() returns undefined).
  const overrideProblems = [];
  for (const name in OV) {
    const ov = OV[name];
    const printings = pocketCards.filter(c => c.name === name);
    if (!printings.length) { overrideProblems.push(`override key '${name}' matches no card name in pocket-cards.json`); continue; }
    if (ov.attackCost && !printings.some(c => (c.attacks || []).some(a => a.name === ov.attackCost.name))) {
      overrideProblems.push(`${name}: attackCost.name "${ov.attackCost.name}" not found on any printing`);
    }
    if (ov.attackEffect) {
      for (const ae of ov.attackEffect) {
        if (!printings.some(c => (c.attacks || []).some(a => a.name === ae.name))) {
          overrideProblems.push(`${name}: attackEffect entry name "${ae.name}" not found on any printing`);
        }
      }
    }
    if (ov.modifyAbility && !printings.some(c => (c.abilities || []).some(a => a.name === ov.modifyAbility.name))) {
      overrideProblems.push(`${name}: modifyAbility.name "${ov.modifyAbility.name}" not found on any printing`);
    }
  }
  if (overrideProblems.length === 0) {
    ok(`all ${Object.keys(OV).length} POCKET_CARD_OVERRIDES entries reference real card/attack/ability names`);
  } else {
    fail(`POCKET_CARD_OVERRIDES reference problem(s):`);
    overrideProblems.forEach(p => console.log(`    - ${p}`));
  }
} catch (e) {
  fail(`could not run Pocket TCG integrity checks: ${e.message}`);
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log();
if (failures === 0) {
  console.log('\x1b[32mAll checks passed.\x1b[0m');
  process.exit(0);
} else {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
}
