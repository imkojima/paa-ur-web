# PAA-UR — 資訊布達網站（PAA Urban Regeneration Web）

自 paa-web 精簡而來的資訊布達網站：頁面管理、最新公告、檔案下載。
前端為無框架的原生 HTML/CSS/JS；後端為單一 Cloudflare Worker（Hono）＋ D1 / KV / R2，
內容由後台管理、前端向 `/api/*` 取資料。會員、入會、相簿、關於我們、服務項目、統計等模組已移除。

> 目前版面、文字與聯絡資訊仍沿用 paa-web（澎湖縣建築師公會），待業主確認後替換。

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

## Deploy（尚未設定）

`api/wrangler.jsonc` 的 D1／KV id 目前是全 0 佔位值，也沒有 `account_id` 與自訂網域 routes，
**在建立業主的 Cloudflare 資源並填入前無法部署**（刻意如此，避免誤部署到 paa-web 的資源）。
建好後：

```bash
npm run deploy:dev    # build(prod) + 部署 paa-ur-dev
npm run deploy:prod   # build(prod) + 部署 paa-ur-prod
```

細節見 `api/README.md`。

## Structure

```
build.mjs             # 前端 build（web/ → dist/；esbuild minify + 內容雜湊）
web/
  index.html          # 殼層（站台級 meta；每頁 meta 由 Worker 邊緣注入）
  admin/              # 後台管理 SPA（index.html / admin.js / admin.css）
  assets/app.js       # 前台 SPA：path router（History API）+ 各頁、首頁輪播
  assets/styles.css   # 樣式
  assets/tinymce/     # 自架 TinyMCE（後台富文本編輯）
api/                  # 後端 Cloudflare Worker（見 api/README.md）
docs/                 # 上線、備份、費用文件（沿用 paa-web，待改寫）
dist/                 # build 產物；git 忽略
```

## Pages

- **首頁** — 輪播、各分類最新公告、檔案下載、相關連結。
- **最新公告** — 分類、關鍵字搜尋、置頂、分頁；內文含附件、上下則、近期公告。
- **檔案下載** — 依分類列出。
- **聯絡我們**、**隱私權政策**、**網站使用條款**、**網站導覽**。
- 未知路徑顯示「建置中」頁。

## 後台模組

公告（含分類、附件、預約發布）、附件總覽、檔案（含分類）、法律頁面、相關連結、輪播、設定（聯絡資訊）、
管理員與操作紀錄（僅 superadmin）。

## Security & ops

- **後台權限**：superadmin／editor／viewer 三級；PBKDF2 密碼雜湊 + KV session（HttpOnly/Secure、`SameSite=Strict`），
  閒置 60 分＋絕對上限 12 小時，`token_version` 可撤銷。
- **防護**：登入有 KV 速率限制與 Turnstile（未設 `TURNSTILE_SECRET` 時略過；site key 需另申請）；上傳有副檔名白名單與 15MB 上限。
- **安全標頭**：CSP 目前 Report-Only。標頭同時由 `api/src/index.ts` 與 `build.mjs`→`dist/_headers` 設定，**兩處需同步**。
- **效能**：公開 `/api/*` 邊緣快取 60s；前端內容雜湊檔名 + 長快取。
- **備份**：`cd api && npm run backup:prod`（D1 dump + R2 鏡像 + 還原驗證），輸出到 repo 外的 `../paa-ur-backup/`。
- **排程**：Cron Trigger 每 5 分鐘把到期的預約公告發布。
