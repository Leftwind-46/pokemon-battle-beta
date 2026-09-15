---
name: pocket-card-art
description: Replace a REAL Pocket TCG card's artwork with a user-edited version (user changed the card's effect via POCKET_CARD_OVERRIDES, then made a corrected card image with the new text and dropped it into `refernce files/`, e.g. `refernce files/A1a_夢幻ex_修正/`). Also for updating/re-replacing such an image later. Triggers on "換卡圖", "修正過的卡圖", "卡圖換成", "更新卡圖", "_修正" folder in refernce files. NOT for brand-new Fan Made cards (those go in public/fan-cards + pocket-cards.json — see pocket-tcg skill).
---

# Pocket TCG：換成使用者修正過的卡圖

## 機制（已經建好，一般情況不用改程式碼）

- 圖放 `public/card-art/<卡號>.jpg` + `<卡號>-sm.jpg`，檔名就是卡號（例 `A1a-032.jpg`）。
- `server.js` 在 `POCKET_CARD_OVERRIDES` 套用迴圈之後（搜 `POCKET_CARD_ART_DIR`）啟動時掃資料夾：
  把該卡的 `image` 換成 `/card-art/<卡號>.jpg?v=<檔案mtime>`，並設 `card._customArt = true`。
  `?v=` 讓換圖後瀏覽器快取自動失效。找不到卡號會 `console.warn` 並略過。
- `public/pocket.html`：
  - `pocketThumbUrl()` 把 `/card-art/X.jpg?v=` 轉成 `/card-art/X-sm.jpg?v=`（圖鑑格/手牌/開包縮圖）。
  - `buildCardPatchOverlay()` 遇到 `_customArt` 直接回傳空字串：新卡圖已經印好正確文字，
    再疊遮蓋框/HP框會把正確內容蓋掉。金色外框（`has-patch`）跟下方招式列表的「⚠️已修改」照舊保留。
- 所有卡圖都走 `/api/pocket/cards` 的 `card.image`，client 沒有另外讀 `pocket-cards.json`，所以不用改 JSON。

## 步驟

1. **看資料夾內每張圖，對應到卡號**。同一隻寶可夢通常有多個稀有度（一般/二星/皇冠…），不要只憑檔名猜：
   ```bash
   python3 -c "import json;[print(c['id'],c['rarity'],c['image']) for c in json.load(open('public/pocket-cards.json'))['cards'] if c['name']=='Mew ex']"
   ```
   同稀有度有兩張以上（例：A1a-077 / A1a-083 都是 Two Star）時，`curl` 原圖到 scratchpad
   `sips -s format png -Z 400` 縮小後用 Read 看，跟使用者的圖比對插畫再決定。
   只有這隻寶可夢的**其中幾張**被修正時，只換那幾張；其他稀有度照原圖（遮蓋框照常顯示）。
2. **轉檔**（每張一次）：
   ```bash
   scripts/card-art.sh "refernce files/<資料夾>/<圖>.png" <卡號>
   ```
   原 PNG 留在 `refernce files/` 不動（那個資料夾沒進 git）。更新既有卡圖也是同一行，直接覆蓋。
3. **驗證**：`PORT=3917 node server.js` 背景跑 →
   `curl -s localhost:3917/api/pocket/cards` 確認目標卡 `image` 是 `/card-art/...` 且 `_customArt: true`
   → 瀏覽器開 `localhost:3917/pocket.html`，javascript_tool 裡
   `fetch('/api/pocket/cards')` 取卡後呼叫 `showCardDetail(card)`，確認 `.detail-img-wrap`
   只有 1 個子元素（img，沒有遮蓋框）、圖有載入，截圖看一眼。結束後 `pkill -f "node server.js"`、關分頁。
4. `npm run verify`，然後 commit+push（程式碼跟 skill 文件同一個 commit）。圖檔要 `git add public/card-art/`。

## 注意

- 使用者修正過的卡圖通常是因為該卡在 `POCKET_CARD_OVERRIDES` 改過效果。換圖前確認卡圖上的文字跟
  override 後的實際效果一致（HP/招式費用/傷害/效果文字），有出入要先問使用者是圖錯還是資料要改。
- 如果某個之後新增的 client 功能直接用 `card.image` 做字串判斷（例如 `endsWith('.webp')`），
  記得 `/card-art/` 網址尾巴帶 `?v=`。
- 要撤回某張修正圖：刪掉 `public/card-art/<卡號>.jpg` 和 `-sm.jpg`，重啟 server 就回到原圖+遮蓋框。

## 紀錄

- 2026-09-15：A1a 夢幻ex 4 張（`refernce files/A1a_夢幻ex_修正/`）：
  一般→A1a-032、二星全圖→A1a-077、二星美術→A1a-083、皇冠→A1a-086。
  卡面是精神射擊（查看對手手牌發動支援者）+ 基因駭入（超無無，對手主戰/板凳/棄牌區任1招）。
- 2026-09-15：A1 尼多后 2 張（`refernce files/A1_尼多后_修正/`）：一般→A1-168、一星→A1-240。
  卡面加印了 override 新增的特性「母儀」。使用者的一星圖左下角印的是★★（真卡 A1-240 是★），
  招式名印「愛之猛擊」（資料 name_zh 是「愛心一擊」）——卡圖照使用者給的放，差異回報給使用者決定。
