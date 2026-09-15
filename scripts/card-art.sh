#!/bin/bash
# 把使用者修正過文字的真實卡卡圖轉成 Pocket TCG 用的圖檔（見 .claude/skills/pocket-card-art）
# 用法：scripts/card-art.sh <來源png> <卡號>   例：scripts/card-art.sh "refernce files/A1a_夢幻ex_修正/夢幻_ex_一般.png" A1a-032
# 產出 public/card-art/<卡號>.jpg（寬750，詳情面板用）+ <卡號>-sm.jpg（寬245，圖鑑格/手牌縮圖用）
# server.js 啟動時自動掃這個資料夾換掉該卡的 image，不用改程式碼。
set -euo pipefail
src="$1"; id="$2"
cd "$(dirname "$0")/.."
[ -f "$src" ] || { echo "找不到來源圖：$src" >&2; exit 1; }
grep -q "\"id\":\"$id\"" public/pocket-cards.json || { echo "pocket-cards.json 裡沒有卡號 $id" >&2; exit 1; }
mkdir -p public/card-art
sips -s format jpeg -s formatOptions 85 --resampleWidth 750 "$src" --out "public/card-art/$id.jpg" >/dev/null
sips -s format jpeg -s formatOptions 80 --resampleWidth 245 "$src" --out "public/card-art/$id-sm.jpg" >/dev/null
ls -la "public/card-art/$id.jpg" "public/card-art/$id-sm.jpg"
