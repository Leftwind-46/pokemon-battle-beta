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

// ── Summary ──────────────────────────────────────────────────────────────
console.log();
if (failures === 0) {
  console.log('\x1b[32mAll checks passed.\x1b[0m');
  process.exit(0);
} else {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
}
