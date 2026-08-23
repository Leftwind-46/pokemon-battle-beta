// Shared extraction helpers for one-off Pocket TCG verification scripts.
// require() this from a scratchpad test file instead of re-writing the same
// string-aware brace matcher / eval-extraction boilerplate every time.
//
//   const { extractBlock, extractObjLiteral, extractFn, extractTopLevelKeys,
//           loadPocketCards, cardById } = require('/Users/.../scripts/pocket-extract');
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const POCKET_HTML_SRC = fs.readFileSync(path.join(ROOT, 'public/pocket.html'), 'utf8');
const POCKET_CARDS_FILE = require(path.join(ROOT, 'public/pocket-cards.json'));
const POCKET_CARDS = POCKET_CARDS_FILE.cards;
const cardById = {};
for (const c of POCKET_CARDS) cardById[c.id] = c;

// String/comment-aware brace matcher — a naive '{'/'}' depth count breaks the moment
// scanned text contains a {W}/{C}-style energy placeholder inside a quoted string,
// which is exactly what real card effect text looks like. This bit it 2026-08-23.
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

// Grab the raw `{ ...body... }` text of `const NAME = { ... };`, from either file.
function extractBlock(varName, src = SERVER_SRC) {
  const startIdx = src.indexOf(`const ${varName} = {`);
  if (startIdx < 0) throw new Error(`const ${varName} = {...} not found`);
  const braceStart = src.indexOf('{', startIdx);
  const end = findMatchingBrace(src, braceStart);
  if (end < 0) throw new Error(`unterminated block for ${varName}`);
  return src.slice(braceStart + 1, end);
}

// eval() a plain-data `const NAME = {...}` (POCKET_CARD_OVERRIDES, POKEMON, TRAINERS —
// anything with no function values). Will throw if the object literal contains
// functions/identifiers that aren't valid outside server.js's own scope.
function extractObjLiteral(varName, src = SERVER_SRC) {
  const startIdx = src.indexOf(`const ${varName} = {`);
  if (startIdx < 0) throw new Error(`const ${varName} = {...} not found`);
  const braceStart = src.indexOf('{', startIdx);
  const end = findMatchingBrace(src, braceStart);
  return eval(`(${src.slice(braceStart, end + 1)})`);
}

// Pull one `function name(...) {...}` out of either file as a standalone, eval-able
// source string. Caller still needs to eval() it and supply any helper functions/
// constants it references (ABILITY_EFFECTS handler bodies routinely call other
// server.js-local helpers — this does NOT resolve those for you).
function extractFn(name, src = SERVER_SRC) {
  const idx = src.indexOf(`function ${name}(`);
  if (idx < 0) throw new Error(`function ${name} not found`);
  const braceStart = src.indexOf('{', idx);
  const end = findMatchingBrace(src, braceStart);
  if (end < 0) throw new Error(`unterminated function ${name}`);
  return src.slice(idx, end + 1);
}

// Top-level string keys of a handler table (ATTACK_EFFECTS / TRAINER_EFFECTS /
// ABILITY_EFFECTS) — 2-space indent, quote-first. Does NOT eval the values (they're
// functions closing over server.js-local helpers that won't resolve standalone).
function extractTopLevelKeys(body) {
  const keyRe = /^  (['"])((?:\\.|(?!\1)[\s\S])*?)\1\s*:/gm;
  let m; const keys = [];
  while ((m = keyRe.exec(body))) {
    try { keys.push(JSON.parse(m[1] === '"' ? m[0].slice(2, m[0].lastIndexOf(m[1]) + 1) : m[2])); }
    catch (e) { keys.push(m[2]); }
  }
  return keys;
}

// The exact "atk.effect after all POCKET_CARD_OVERRIDES.attackEffect mutations" text
// ATTACK_EFFECTS actually gets looked up by at runtime — mirrors the load-time patch
// loop in server.js. Use this, never raw pocket-cards.json text, when checking whether
// an ATTACK_EFFECTS key is reachable.
function liveAttackEffectTexts(overrides) {
  const OV = overrides || extractObjLiteral('POCKET_CARD_OVERRIDES');
  const texts = new Set();
  for (const c of POCKET_CARDS) {
    const ov = OV[c.name];
    const attacks = (c.attacks || []).map(a => ({ ...a }));
    if (ov && ov.attackEffect) {
      for (const ae of ov.attackEffect) {
        const a = attacks.find(x => x.name === ae.name);
        if (a) a.effect = ae.effect;
      }
    }
    for (const a of attacks) if (a.effect) texts.add(a.effect);
  }
  return texts;
}

module.exports = {
  ROOT, SERVER_SRC, POCKET_HTML_SRC, POCKET_CARDS, cardById,
  findMatchingBrace, extractBlock, extractObjLiteral, extractFn, extractTopLevelKeys,
  liveAttackEffectTexts,
};
