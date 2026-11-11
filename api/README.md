# PAA-UR 後端（Cloudflare Worker）

單一 Worker 同時服務**前台 build 產物（`../dist`，原始碼在 `../web`）**與 **`/api/*`（Hono）**。
採 **dev / prod 兩套環境**，各自獨立的 Worker、D1、KV、R2。

## 環境與資源

Cloudflare 帳號：**PAA 澎湖縣建築師公會**（`account_id` 寫在 `wrangler.jsonc` 的每個環境區塊；頂層的值 `wrangler d1 … --env` 讀不到）。

| | dev | prod |
|---|---|---|
| Worker | `paa-ur-dev` | `paa-ur-prod` |
| 網址 | https://paa-ur-dev.paa-612.workers.dev | （未部署） |
| D1 | `paa-ur-db-dev`（`11dc589a-8d24-4f2b-8ca8-0b27f163ae27`） | `paa-ur-db`（待建立） |
| KV | `paa-ur-kv-dev`（`bea72eaec51d4835a7f5dfe692424d6b`） | `paa-ur-kv-prod`（待建立） |
| R2 | `paa-ur-files-dev` | `paa-ur-files`（待建立） |

dev 已建立並部署（2026-11-06）。prod 的 D1／KV id 仍是全 0 佔位值，建立步驟見 `../docs/上線部署手冊.md`。

> ⚠️ 本機 D1 的資料檔是依 `database_id` 對應的。改了 `wrangler.jsonc` 裡 dev 的 `database_id`，
> `--local` 就會指到一個新的空資料庫（舊資料仍在 `.wrangler/state/v3/d1/` 底下，只是不再被讀到）。

## 常用指令

> 本機 Node 需 ≥ 22。

```bash
cd api
npm install

# 本機開發（dev 綁定、本機 D1）
npm run db:migrate:dev:local   # 首次：套用 schema
npm run seed:dev:local         # 首次：灌 demo 資料（seeds/0001_content.sql）
npm run dev

# 部署（prod 需先建立資源）
npm run deploy:dev
npm run deploy:prod

# 遠端資料庫 migration
npm run db:migrate:dev
npm run db:migrate:prod

# 備份（D1 dump + R2 鏡像）
npm run backup:prod
npm run backup:verify:prod
```

## 結構

```
api/
├─ src/
│  ├─ index.ts          # Hono 進入點：公開 API（含 /api/pages、/api/faqs、/api/inquiries）、SPA fallback、邊緣 meta 注入、安全標頭、sitemap/robots、cron
│  ├─ admin.ts          # 後台 API（公告/附件/檔案/頁面/常見問答/諮詢收件匣/法律頁面/友站/輪播/設定/管理者/稽核紀錄）
│  ├─ auth.ts           # PBKDF2、session store、速率限制、Turnstile 驗證
│  ├─ platform.ts       # Workers 平台相依的唯一集中處
│  └─ meta.ts           # 每頁 title／社群分享 meta
├─ migrations/          # D1 schema：0001_init（自 paa-web 合併精簡）、0002_home_intro（首頁簡介預設內容）、
│                       #   0003_county_revision（縣府退件修正：頁面、常見問答、諮詢、分類、consult 設定）、
│                       #   0004_brochure_sync（依正式版摺頁校正頁面與問答文字）
├─ seeds/               # demo-data.js（虛構示範資料）+ gen 出的 0001_content.sql
├─ scripts/             # gen-seed / hash-password / backup / verify-backup
└─ wrangler.jsonc
```

`pages` 表已接上「頁面管理」：slug 固定為 `plan`／`subsidy`／`process`／`contact`，與前台路由一對一，後台只能編修。
`menu_items` 表仍未使用（主選單寫在 `web/assets/app.js` 的 `NAV`）。

### 0003 帶入的資料表與設定

| 項目 | 說明 |
|---|---|
| `faq_categories`／`faqs` | 常見問答（五類、26 題初稿），`answer` 為 HTML |
| `inquiries` | 線上諮詢案件（網站表單、LINE、電話）。**目前停用**：`index.ts` 的 `INQUIRY_FORM_ENABLED=false`，公開 POST 回 404，後台不顯示收件匣 |
| `settings.consult` | `line_url`、`line_id`、`hours`（值班時段）、`reply_sla`、`notify_email`（通知信箱，功能未實作） |
| `settings.contact.hours` | 服務時間 |

所有種子資料只在尚無資料時寫入；`contact` 只有在地址空白時才帶入公會資料（dev 因已有 seed 示範資料，未被覆蓋）。

> D1 的 migration 不接受太長的 `UNION ALL`（SQLITE 的 compound SELECT 上限），大量種子資料請逐筆 `INSERT`。

## 平台相依（`platform.ts`）

Workers 專屬的全域 API（`executionCtx.waitUntil`／`caches.default`／`CF-Connecting-IP`）全部集中在
`platform.ts`；其餘資源一律經 `c.env.*` 綁定存取。**新增 Workers 專屬 API 時請一律經由本檔**。

## 慣例

- **改 schema**：在 `migrations/` 新增 `000N_xxx.sql`，先 `db:migrate:dev` 驗證，再 `db:migrate:prod`。
- **demo 資料**：改 `seeds/demo-data.js` 後跑根目錄的 `npm run gen:seed`。
- 日期以西元儲存，前台轉民國顯示。
