---
name: pokemon-balance-export
description: Use when the user wants the current POKEMON roster (stats/moves/abilities, including Mega evolution info) dumped to a spreadsheet for balance review — e.g. "整理成excel給我", "匯出excel", "balance list", "平衡review用的表格", "我想自己調整數值". Produces `pokemon_balance_list.xlsx` at the repo root.
---

# Pokémon Balance Excel Export

Regenerates `pokemon_balance_list.xlsx` (repo root, tracked but always **regenerated on request, not hand-maintained** — same convention as the older `pokemon_balance_list.csv` it supersedes, see pokemon-data skill). The user reviews it in Excel/Numbers and calls out specific Pokémon/numbers to change (this is how e.g. the 皮皮 removal on 2026-07-15 was decided, and how the 2026-07-24 HP-rebalance pass started).

There is no committed generator script — write the two scripts below fresh into the scratchpad each time and run them. This keeps the no-build-system repo free of an npm dependency (Node has no built-in xlsx writer) while still using a real `.xlsx` file rather than CSV, so Mega columns/colors/filters render properly in Excel/Numbers.

## Why two languages

Node already has the battle-tested "extract a `const X = [...]` out of the HTML `<script>` block and `eval` it" pattern (`scripts/verify.js`'s `extractArray`) — reuse it rather than re-parsing JS-with-unquoted-keys in Python. Node dumps to JSON; Python's `openpyxl` (already installed on this machine — if missing on a fresh machine, `pip install openpyxl`) turns that JSON into a styled `.xlsx`. No npm install needed either way.

## Step 1 — extract POKEMON + SUPPORT_EFFECT_ZH to JSON

Write to scratchpad as `extract_pokemon.js`:

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
const SRC_FILE = process.argv[3] || 'pokemon_battle.html';
const html = fs.readFileSync(path.join(ROOT, SRC_FILE), 'utf8');

function extractArray(text, varName) {
  const re = new RegExp(`const ${varName} = \\[[\\s\\S]*?\\n\\];`);
  const m = text.match(re);
  if (!m) throw new Error(`const ${varName} = [...] not found`);
  return eval(m[0].replace(`const ${varName} = `, ''));
}
const POKEMON = extractArray(html, 'POKEMON');

function extractObject(text, varName) {
  const re = new RegExp(`const ${varName} = \\{[\\s\\S]*?\\n\\};`);
  const m = text.match(re);
  if (!m) throw new Error(`const ${varName} = {...} not found`);
  const body = m[0].replace(`const ${varName} = `, '').replace(/;\s*$/, '');
  return eval('(' + body + ')');
}
const supportZh = extractObject(html, 'SUPPORT_EFFECT_ZH');

console.log(JSON.stringify({ pokemon: POKEMON, supportEffectZh: supportZh }));
```

Run it against the **single-player source of truth** (`pokemon_battle.html` — per pokemon-data skill, `public/single.html` is a byte-identical mirror so either works, but prefer the canonical one):

```
node /path/to/scratchpad/extract_pokemon.js /path/to/repo/root > /path/to/scratchpad/pokemon_data.json
```

`server.js` has its own **separate** `POKEMON`/`TRAINERS` arrays for PvP (not shared — see pokemon-data skill) and does **not** have `SUPPORT_EFFECT_ZH` (that's a client-only display map). If the user ever wants the PvP roster exported too, pass `server.js` as the third arg and stub `supportEffectZh` to `{}` in step 2 instead of reusing this same script unmodified.

## Step 2 — build the styled .xlsx

Write to scratchpad as `build_pokemon_xlsx.py`:

```python
#!/usr/bin/env python3
import json
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

TYPE_ZH = {
    'fire':'火','water':'水','grass':'草','electric':'電','psychic':'超能','fighting':'格鬥',
    'ghost':'幽靈','dragon':'龍','steel':'鋼','ice':'冰','normal':'一般','dark':'惡',
    'ground':'地面','flying':'飛行','rock':'岩石','fairy':'妖精','poison':'毒','bug':'蟲',
}
TIER_ZH = {1:'第1關(弱)', 2:'第2關(中)', 3:'第3關(強)'}

json_path, out_path = sys.argv[1], sys.argv[2]
data = json.load(open(json_path, encoding='utf-8'))
pokemon = data['pokemon']
support_zh = data['supportEffectZh']

def t(type_key):
    return TYPE_ZH.get(type_key, type_key or '')

def move_special_text(a):
    parts = []
    if a.get('support'):
        parts.append(support_zh.get(a.get('effect'), '輔助技能'))
    else:
        if a.get('megaBoost'):
            parts.append('Mega能量 ×2')
        elif a.get('bonusEnergy'):
            parts.append(f"下回合 +{a['bonusEnergy']} 能量")
        if a.get('selfHeal'):
            parts.append(f"命中回復自身 {round(a['selfHeal']*100)}% 最大HP")
    return '；'.join(parts)

HEADERS = ['編號','名稱','屬性1','屬性2','HP','關卡','特性名稱','特性說明',
           '可Mega進化','Mega屬性1','Mega屬性2','Mega特性名稱','Mega特性說明','Mega SpriteID']
for i in range(1, 5):
    HEADERS += [f'招式{i}名稱', f'招式{i}威力', f'招式{i}消耗', f'招式{i}屬性',
                f'招式{i}異常', f'招式{i}機率', f'招式{i}特殊效果']

wb = Workbook()
ws = wb.active
ws.title = '寶可夢平衡總表'
ws.append(HEADERS)

header_fill = PatternFill(start_color='FF2D2F5D', end_color='FF2D2F5D', fill_type='solid')
header_font = Font(bold=True, color='FFFFFFFF')
mega_fill = PatternFill(start_color='FFF3E5F5', end_color='FFF3E5F5', fill_type='solid')
for cell in ws[1]:
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal='center', vertical='center')
ws.freeze_panes = 'C2'

MEGA_COL_START, MEGA_COL_END = 9, 14

for p in pokemon:
    mega = p.get('mega')
    ability = p['ability']
    row = [
        p['id'], p['name'], t(p['type']), t(p.get('type2')), p['hp'], TIER_ZH.get(p.get('tier'), ''),
        ability['name'], ability['desc'],
        '是' if mega else '否',
        t(mega['type']) if mega else '',
        t(mega.get('type2')) if mega else '',
        mega['ability']['name'] if mega else '',
        mega['ability']['desc'] if mega else '',
        mega['spriteId'] if mega else '',
    ]
    attacks = p['attacks']
    for i in range(4):
        a = attacks[i] if i < len(attacks) else None
        if a is None:
            row += ['', '', '', '', '', '', '']
            continue
        status = a.get('status')
        row += [
            a['name'],
            '輔助' if a.get('support') else a.get('dmg', ''),
            a.get('cost', ''),
            t(a.get('type')),
            {'poison':'中毒','paralysis':'麻痺','burn':'燒傷','sleep':'睡眠','confusion':'混亂','freeze':'結凍'}.get(status['effect'], status['effect']) if status else '',
            f"{round(status['chance']*100)}%" if status else '',
            move_special_text(a),
        ]
    ws.append(row)
    if mega:
        r = ws.max_row
        for c in range(MEGA_COL_START, MEGA_COL_END + 1):
            ws.cell(row=r, column=c).fill = mega_fill

widths = [7,10,7,7,6,10,10,26] + [7,7,7,12,26,10] + ([12,7,7,7,7,7,26] * 4)
for i, w in enumerate(widths, start=1):
    ws.column_dimensions[get_column_letter(i)].width = w

ws.auto_filter.ref = ws.dimensions

wb.save(out_path)
print(f'wrote {out_path}: {len(pokemon)} rows')
```

Run it, then copy the result to the repo root:

```
python3 /path/to/scratchpad/build_pokemon_xlsx.py /path/to/scratchpad/pokemon_data.json /path/to/scratchpad/pokemon_balance_list.xlsx
cp /path/to/scratchpad/pokemon_balance_list.xlsx /path/to/repo/root/pokemon_balance_list.xlsx
```

## Column layout

`編號/名稱/屬性1/屬性2/HP/關卡/特性名稱/特性說明` then `可Mega進化/Mega屬性1/Mega屬性2/Mega特性名稱/Mega特性說明/Mega SpriteID` (this block is what the old CSV never had — highlighted with a light purple fill on rows where `可Mega進化=是`), then 4 repeated move blocks of `名稱/威力/消耗/屬性/異常/機率/特殊效果` (support moves show `威力` as the literal string `輔助` since they deal no damage).

`特殊效果` is derived straight from the same fields the in-game move-info popup reads (`megaBoost`/`bonusEnergy`/`selfHeal`/`support`+`effect` via `SUPPORT_EFFECT_ZH`) — see `pokemon_battle.html` around the `mip-row` rendering (~line 2851) if this drifts from what's shown in-game.

## After generating

Tell the user where the file landed (`pokemon_balance_list.xlsx`, repo root) and that it's a review artifact, not a source of truth — edits to the spreadsheet don't feed back into the game automatically. If they hand-edit numbers and want them applied, that's a separate task: read their changes back out and edit `pokemon_battle.html` (and mirror to `public/single.html` + `server.js` per pokemon-data skill) directly.

Don't commit/push the regenerated file unless the user's standing auto-commit preference applies and they'd expect a binary spreadsheet in git history — check before assuming an `.xlsx` diff is welcome the way an `.html` diff is.
