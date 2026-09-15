#!/usr/bin/env python3
"""Pocket TCG 卡圖自己存：public/card-img/<系列>/<卡號>.webp（大圖，寬≤600）+ <卡號>-sm.webp（縮圖，寬245）。

用法：
  python3 scripts/card-img-sync.py                 # 把 pocket-cards.json 裡還指向外部網址的卡全部抓下來、改成本地路徑
  python3 scripts/card-img-sync.py --add 圖.png A1-001 [更多 圖 卡號 ...]   # 用本地圖檔當某張卡的卡圖（新卡/外部沒圖的卡）
  python3 scripts/card-img-sync.py --check         # 只檢查每張卡的本地大圖/縮圖是否都存在，不下載不改檔

外部原始網址保留在每張卡的 imageSource 欄位（之後要重抓時用）。已存在的檔案會略過，可以重複執行。
使用者修正過文字的卡圖不走這裡，放 public/card-art/（見 .claude/skills/pocket-card-art），server 會蓋過 image。
"""
import io, json, sys, urllib.request, concurrent.futures as cf
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / 'public' / 'pocket-cards.json'
OUT = ROOT / 'public' / 'card-img'
FULL_W, THUMB_W = 600, 245


def local_paths(card):
    d = OUT / card['set']
    return d / f"{card['id']}.webp", d / f"{card['id']}-sm.webp", f"/card-img/{card['set']}/{card['id']}.webp"


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 pokemon-leisure-games card-img-sync'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def save_webp(img, path, width, quality):
    img = img.convert('RGBA') if img.mode in ('P', 'LA') else img
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, 'WEBP', quality=quality, method=6)


def build(card, src_bytes, src_url=''):
    full, thumb, _ = local_paths(card)
    if not full.exists():
        # TCGdex high.webp 本身就是 600 寬 webp，原檔直接存，不重新壓縮避免畫質再掉一次
        if src_url.endswith('/high.webp'):
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(src_bytes)
        else:
            save_webp(Image.open(io.BytesIO(src_bytes)), full, FULL_W, 85)
    if not thumb.exists():
        save_webp(Image.open(full), thumb, THUMB_W, 80)


def sync_one(card):
    full, thumb, local = local_paths(card)
    src = card.get('imageSource') or card.get('image') or ''
    if not src.startswith('http'):
        return card['id'], 'skip'
    if full.exists() and thumb.exists():
        return card['id'], 'exists'
    try:
        build(card, b'' if full.exists() else fetch(src), src)
        return card['id'], 'ok'
    except Exception as e:  # 單張失敗不中斷整批，最後列出來
        return card['id'], f'FAIL {e}'


def load():
    return json.loads(JSON_PATH.read_text(encoding='utf8'))


def dump(data):
    JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf8')


def main():
    args = sys.argv[1:]
    data = load()
    by_id = {c['id']: c for c in data['cards']}

    if args[:1] == ['--check']:
        missing = [c['id'] for c in data['cards']
                   if c.get('image', '').startswith('/card-img/') and not all(p.exists() for p in local_paths(c)[:2])]
        external = [c['id'] for c in data['cards'] if c.get('image', '').startswith('http')]
        print(f'本地檔案缺漏 {len(missing)}：{missing[:20]}')
        print(f'仍指向外部網址 {len(external)}：{external[:20]}')
        sys.exit(1 if missing or external else 0)

    if args[:1] == ['--add']:
        pairs = args[1:]
        if not pairs or len(pairs) % 2:
            sys.exit('用法：--add <圖檔> <卡號> [<圖檔> <卡號> ...]')
        for src, cid in zip(pairs[::2], pairs[1::2]):
            card = by_id.get(cid) or sys.exit(f'pocket-cards.json 裡沒有卡號 {cid}（新卡要先把卡片資料加進 JSON）')
            full, thumb, local = local_paths(card)
            full.unlink(missing_ok=True); thumb.unlink(missing_ok=True)  # --add 一律覆蓋
            build(card, Path(src).read_bytes())
            if card.get('image', '').startswith('http'):
                card['imageSource'] = card['image']
            card['image'] = local
            print(cid, '->', local, f'{full.stat().st_size // 1024}KB / {thumb.stat().st_size // 1024}KB')
        dump(data)
        return

    todo = [c for c in data['cards'] if (c.get('imageSource') or c.get('image') or '').startswith('http')]
    print(f'外部卡圖 {len(todo)} 張，開始同步…')
    fails = []
    with cf.ThreadPoolExecutor(16) as ex:
        for i, (cid, status) in enumerate(ex.map(sync_one, todo), 1):
            if status.startswith('FAIL'):
                fails.append((cid, status))
            if i % 250 == 0:
                print(f'  {i}/{len(todo)}')
    for c in todo:
        full, thumb, local = local_paths(c)
        if full.exists() and thumb.exists() and c['image'].startswith('http'):
            c['imageSource'] = c['image']
            c['image'] = local
    dump(data)
    print(f'完成，失敗 {len(fails)} 張')
    for f in fails:
        print('  ', *f)


if __name__ == '__main__':
    main()
