# PAA-UR — 澎湖縣老宅延壽機能復新計畫（資訊布達網站）

「澎湖縣老宅延壽機能復新計畫」的資訊布達網站，由社團法人澎湖縣建築師公會維運。
自 paa-web 精簡而來，2026-11 依澎湖縣政府審查意見（府建管字第1150065778號）補上計畫介紹、常見問答、線上諮詢。
前端為無框架的原生 HTML/CSS/JS；後端為單一 Cloudflare Worker（Hono）＋ D1 / KV / R2，
內容由後台管理、前端向 `/api/*` 取資料。會員、入會、相簿、關於我們、服務項目、統計等模組已移除。

> 站名、主視覺、相關連結已定案；計畫說明、補助辦法、申請流程、常見問答已有初稿（`0003` migration 帶入，待縣府確認）。
> 說明會簡報、摺頁、海報已上傳到 dev。**dev 的聯絡資訊、公告與申請表單仍是 seed 的虛構示範資料**（例：「示範市示範區示範路 1 號」），
> 正式上線前需在後台換成實際內容。

## Run（本機開發）

```bash
npm install                      # 根目錄：build 工具（esbuild）
cd api && npm install            # 後端：hono + wrangler

# 首次：建立本機 D1、灌 demo 資料、建立管理員
npm run db:migrate:dev:local
npm run seed:dev:local
node scripts/hash-password.mjs '<密碼>'   # 產生 password_hash
npx wrangler d1 execute paa-ur-db-dev --local --env dev \
  --command "INSERT INTO admin_users (username, password_hash, name, role) VALUES ('admin', '<hash>', '管理員', 'superadmin')"

cd .. && npm run dev             # build:dev + wrangler dev --env dev
# 前台 http://localhost:8787/　後台 http://localhost:8787/admin/
# 邊改邊看：另開終端機跑 `npm run watch`（監看 web/ 自動重建 dist/）
```

> `web/`＝可編輯原始碼，`npm run build` 以 esbuild 壓縮並加內容雜湊檔名輸出到 `dist/`（git 忽略），
> Worker 服務 `dist/`。dev 模式（`build:dev`）為純複製、不壓縮、可直接除錯。

## Deploy

Cloudflare 帳號：**PAA 澎湖縣建築師公會**。

| 環境 | 狀態 | 網址 |
|---|---|---|
| dev | 已部署（2026-11-06） | https://paa-ur-dev.paa-612.workers.dev（後台 `/admin/`） |
| prod | 資源尚未建立 | — |

```bash
npm run deploy:dev    # build(prod) + 部署 paa-ur-dev
npm run deploy:prod   # build(prod) + 部署 paa-ur-prod（需先建立 prod 資源）
```

- 改了 schema（新增 `api/migrations/000N_*.sql`）要先 `cd api && npm run db:migrate:dev`，再部署。
- `account_id` 寫在 `api/wrangler.jsonc` 的每個環境區塊裡（頂層的值 D1 指令讀不到），不需另外設 `CLOUDFLARE_ACCOUNT_ID`。
- wrangler 需先登入：`npx wrangler login`。在 Claude Code 裡請用 `! npx wrangler login` 執行（`!` 前不能有空格）。
- prod 首次上線、自訂網域、上線前的安全性收尾，見 `docs/上線部署手冊.md`；資源與 id 見 `api/README.md`。

## Structure

```
build.mjs             # 前端 build（web/ → dist/；esbuild minify + 內容雜湊）
web/
  index.html          # 殼層（站台級 meta；每頁 meta 由 Worker 邊緣注入）。站名改動需與 app.js、api/src/meta.ts 同步
  admin/              # 後台管理 SPA（index.html / admin.js / admin.css）
  assets/app.js       # 前台 SPA：path router（History API）+ 各頁、首頁輪播
  assets/styles.css   # 樣式
  assets/tinymce/     # 自架 TinyMCE（後台富文本編輯）
api/                  # 後端 Cloudflare Worker（見 api/README.md）
docs/                 # 上線部署手冊（paa-ur 版）、架構圖（docs/架構圖/）；備份、費用文件仍沿用 paa-web，待改寫
dist/                 # build 產物；git 忽略
```

## Pages

主選單依民眾申請步驟排列：首頁、計畫介紹、最新公告、資料下載、常見問答、線上諮詢、聯絡我們。

- **首頁** — 主視覺（輪播；有圖時整張顯示）、快速入口（補助辦法、申請流程、申請表單下載、常見問答、線上諮詢）、
  最新公告 6 則、首頁簡介、資料下載分類、相關連結。
- **計畫介紹**（下拉）— 計畫說明 `/plan`、補助辦法 `/subsidy`、申請流程 `/process`。內容由後台「頁面」維護。
- **最新公告** `/news` — 分類（一般公告、新聞稿、活動訊息、宣導資訊）、關鍵字搜尋、置頂、分頁；內文含附件、上下則。
- **資料下載** `/downloads` — 依分類列出：申請表單、說明會簡報、宣傳手冊／摺頁、其他文件。
- **常見問答** `/faq` — 五類（申請資格、補助項目、申請程序、審查作業、其他），分類篩選、關鍵字搜尋、點選展開。
- **線上諮詢** `/consult` — LINE 官方帳號（後台設定連結；未設定時顯示「即將開放」）＋電話與 Email。
- **聯絡我們** `/contact` — 聯絡窗口表（執行／主辦／指導單位，後台「頁面」維護）、服務時間、相關連結。
- **隱私權政策**、**網站使用條款**、**網站導覽**。未知路徑顯示「找不到這個頁面」。

> **線上提問表單與諮詢收件匣目前停用**（諮詢可能不在本後台處理）。程式與 `inquiries` 資料表保留：
> 要啟用時把 `api/src/index.ts` 的 `INQUIRY_FORM_ENABLED` 改成 `true`，並在 `web/admin/admin.js` 的 `MODULES` 加回
> `['inquiries', '線上諮詢']`。啟用後前台線上諮詢頁會出現提問表單（Turnstile＋同 IP 每小時 5 件），後台有收件匣與月報 CSV 匯出。

## 後台模組

公告（含分類、附件、預約發布）、頁面（計畫說明／補助辦法／申請流程／聯絡窗口；只能編修不能新增刪除）、
常見問答（含分類）、附件總覽、檔案（含分類）、法律頁面、相關連結、輪播、首頁簡介、
設定（聯絡資訊、服務時間、LINE 連結、值班時段）、管理員與操作紀錄（僅 superadmin）。

## 社群分享圖（OG image）

`web/assets/og-cover-v3.jpg`（1200×630），由首頁主視覺左右補模糊邊製成。**換了首頁輪播圖不會自動更新**，
需另做一張並換新檔名（例 `og-cover-v4.jpg`，讓 Facebook／LINE 重新抓），同步改 `web/index.html` 與 `api/src/meta.ts`。

## Security & ops

- **後台權限**：superadmin／editor／viewer 三級；PBKDF2 密碼雜湊 + KV session（HttpOnly/Secure、`SameSite=Strict`），
  閒置 60 分＋絕對上限 12 小時，`token_version` 可撤銷。
- **防護**：登入有 KV 速率限制與 Turnstile（未設 `TURNSTILE_SECRET` 時略過；site key 需另申請）；上傳有副檔名白名單與 15MB 上限。
- **上線前閘門**：prod 設了 `BASIC_AUTH_USER`／`BASIC_AUTH_PASS` 兩個 secret 時，全站要求 Basic Auth；刪掉 secret 即解除。dev 不受影響。
- **dev 不被收錄**：非 prod 環境全站回 `X-Robots-Tag: noindex, nofollow`，robots.txt 也整站禁止。
- **安全標頭**：CSP 目前 Report-Only。標頭同時由 `api/src/index.ts` 與 `build.mjs`→`dist/_headers` 設定，**兩處需同步**。
- **效能**：公開 `/api/*` 邊緣快取 60s；前端內容雜湊檔名 + 長快取。
- **備份**：`cd api && npm run backup:prod`（D1 dump + R2 鏡像 + 還原驗證），輸出到 repo 外的 `../paa-ur-backup/`。
- **排程**：Cron Trigger 每 5 分鐘把到期的預約公告發布。
