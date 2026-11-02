# 🎴 合夥買卡資金池與交易動態管理系統

6 人合夥買賣球星卡嘅資金池帳目系統。純靜態網頁（GitHub Pages），雲端資料庫用你自己嘅 Google 試算表（Google Apps Script）。

**網站：** https://yellowbluered.github.io/card-damojj/

---

## 功能

| 功能 | 說明 |
| --- | --- |
| 動態份額 | 份額 = 個人歷史累計入資 ÷ 全隊歷史累計總入資 × 100%，每次改動即時重算 |
| 買卡建倉 | 記錄日期、卡牌名稱、成交價、運費手續費、決策授權、相片 |
| 平倉賣出 | 輸入成交價與費用，自動計淨回款與盈虧 |
| 賣出分紅 | 每張已賣出卡牌有「分紅」按鈕，列出每位成員按份額可分幾多錢 |
| 剷除紀錄 | 卡牌同入金都有獨立刪除掣，**彈窗確認**後先刪 |
| 跨裝置同步 | 任何裝置改動 4 秒內全部裝置見到（見下方原理） |
| 匯出 | CSV（Excel 可開）、完整 JSON 備份、列印／PDF |

## 雲端同步原理

```
手機 / iPad / 電腦 (index.html)
        │  POST JSON（每 4 秒輪詢 + 每次改動即時推送）
        ▼
Google Apps Script Web App  ──►  你的 Google 試算表（DB 工作表，一行一筆紀錄）
        │
        └─► 卡牌相片存喺 Google Drive「資金池卡牌相片」資料夾
```

### 衝突處理

唔係「整個檔案覆蓋」，而係**逐筆紀錄 Last-Write-Wins**：

- 每筆入金／卡牌都有 `id` 同 `updatedAt`（毫秒時間戳）
- 任何人提交，伺服器會將佢同現有資料逐筆合併，`updatedAt` 較大者勝出
- 刪除唔係真刪，而係寫入 `deleted: true` 墓碑（tombstone），再同步出去
- 所以兩個人同一秒一齊加卡，**兩張都會保留**，唔會互相覆蓋

## 一次性設定（約 8 分鐘）

1. 開 https://yellowbluered.github.io/card-damojj/setup.html
2. 跟住 1–5 步做（開試算表 → Apps Script → 貼代碼 → 部署 → 貼網址）
3. 產生「分享連結」，傳去群組
4. 其他人一撳條連結就自動連上，唔需要做任何設定

> 部署時「具有應用程式存取權的使用者」一定要揀 **任何人**，否則手機連唔到。

## 檔案結構

```
index.html              主程式（單檔，無需 build）
setup.html              設定精靈（產生後端代碼、分享連結、QR）
apps-script/Code.gs     雲端後端（貼入 Google Apps Script）
tools/mock-server.mjs   本機測試用：模擬 Apps Script API + 靜態伺服器
tools/e2e.mjs           端到端測試：真實 Chrome 開兩個「裝置」驗證同步
```

## 本機開發 / 測試

```bash
node tools/mock-server.mjs        # API :8787, 網站 :8788
node tools/e2e.mjs                # 自動開兩個 Chrome 分頁做同步測試
```

`tools/e2e.mjs` 會驗證：分享連結自動設定、跨裝置新增／刪除／買卡／賣出同步、
分紅明細加總、以及有無 JavaScript 錯誤。

## 資料模型

```jsonc
// 入金
{ "id": "d_x1y2", "month": "2026-01", "member": "Marco",
  "amount": 1000, "updatedAt": 1730000000000 }

// 卡牌
{ "id": "c_x1y2", "buyDate": "2026-01-05", "name": "2023 Prizm Wembanyama RC",
  "costPrice": 4500, "fee": 50, "totalCost": 4550, "note": "Marco 獨力決定",
  "status": "ACTIVE",              // ACTIVE | SOLD
  "imageUrl": "",                  // Google Drive 縮圖網址
  "sellDate": null, "sellPrice": null, "sellFee": null,
  "netReturn": null, "profit": null,
  "updatedAt": 1730000000000 }
```

## 注意事項

- 資料係你自己嘅 Google 帳戶，唔會經第三方伺服器。
- 分享連結含密鑰（`?k=...`），唔好公開貼上網。
- 相片上載需要 Apps Script 有 Drive 權限（第一次部署授權時已包含）。
- iOS Safari 唔支援 `<input type="month">`，會退化成文字輸入，格式用 `YYYY-MM` 即可。
