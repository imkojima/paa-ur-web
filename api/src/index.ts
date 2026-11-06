import { Hono } from 'hono';
import { admin } from './admin';
import { resolveMeta, injectMeta } from './meta';
import { background, edgeCache } from './platform';

// Turnstile Site Key（公開值；前端用）。Secret 為 Worker 機密 TURNSTILE_SECRET。
// 上線前需為本站網域另申請一組 key（paa-web 那組綁在 paa.org.tw）；未設 secret 時登入不驗證。
const TURNSTILE_SITE_KEY = '';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  TURNSTILE_SECRET?: string;
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASS?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 上線前暫時性閘門：prod 且有設定 BASIC_AUTH_USER/BASIC_AUTH_PASS 這兩個 secret 才生效
// （正式對外開放後，把這兩個 secret 刪掉即可解除，不需重新部署）。
// 閘門生效期間，所有回應一律標記 no-store：Cloudflare 邊緣對部分回應（尤其靜態資產）
// 會不管 Worker 邏輯直接快取重播（同一顆 worker 先前處理 noindex 標頭時也踩過這坑），
// 若 401 或已驗證的 200 被快取住，會讓瀏覽器明明送對帳密卻吃到舊回應、誤判驗證失敗而重跳登入框。
const BASIC_AUTH_REALM = 'Basic realm="PAA-UR-prelaunch"';
app.use('*', async (c, next) => {
  const user = c.env.BASIC_AUTH_USER;
  const pass = c.env.BASIC_AUTH_PASS;
  if (c.env.ENVIRONMENT !== 'prod' || !user || !pass) return next();
  const authHeader = c.req.header('Authorization') || '';
  const [scheme, encoded] = authHeader.split(' ');
  let ok = false;
  if (scheme === 'Basic' && encoded) {
    try {
      const decoded = atob(encoded);
      const sep = decoded.indexOf(':');
      ok = sep >= 0 && timingSafeEqual(decoded.slice(0, sep), user) && timingSafeEqual(decoded.slice(sep + 1), pass);
    } catch { /* malformed header */ }
  }
  if (!ok) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': BASIC_AUTH_REALM, 'Cache-Control': 'no-store' },
    });
  }
  await next();
  if (c.res) {
    try { c.res.headers.set('Cache-Control', 'no-store'); } catch {
      const h = new Headers(c.res.headers);
      h.set('Cache-Control', 'no-store');
      c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h });
    }
  }
});

// CSP（Report-Only 觀察期：不阻擋、僅回報違規到 /api/csp-report）。
// 注意：build.mjs 的 dist/_headers 也有同一份，修改請兩處同步。
const CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; " +
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; " +
  "connect-src 'self' https://cloudflareinsights.com; frame-src 'self' blob: https://challenges.cloudflare.com https://www.openstreetmap.org; worker-src 'self' blob:; " +
  "frame-ancestors 'self'; form-action 'self'; report-uri /api/csp-report";

// 安全性標頭（Worker 產生的回應；靜態資產由 dist/_headers 設定）
const SEC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy-Report-Only': CSP,
};
app.use('*', async (c, next) => {
  await next();
  // 非正式環境（dev）全站 noindex：測試站不應被搜尋引擎索引、與正式站競爭排名。正式站不受影響。
  const noindex = c.env.ENVIRONMENT !== 'prod';
  try {
    for (const k in SEC_HEADERS) c.res.headers.set(k, SEC_HEADERS[k]);
    if (noindex) c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  } catch {
    // 不可變標頭（如 ASSETS 直送）→ 重建回應
    const r = c.res;
    const h = new Headers(r.headers);
    for (const k in SEC_HEADERS) h.set(k, SEC_HEADERS[k]);
    if (noindex) h.set('X-Robots-Tag', 'noindex, nofollow');
    c.res = new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  }
});

// 公開讀取 API 邊緣快取（GET /api/*，排除 admin）：減少 D1、加速回訪。
// 內容編輯後最多 60 秒生效。
app.use('/api/*', async (c, next) => {
  const p = new URL(c.req.url).pathname;
  if (c.req.method !== 'GET' || p.startsWith('/api/admin')) return next();
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const hit = await edgeCache.match(cacheKey);
  if (hit) { c.res = hit; return; }
  await next();
  if (c.res && c.res.status === 200) {
    const h = new Headers(c.res.headers);
    h.set('Cache-Control', 'public, max-age=60');
    const buf = await c.res.arrayBuffer();
    const toCache = new Response(buf, { status: 200, headers: h });
    background(c, edgeCache.put(cacheKey, toCache.clone()));
    c.res = toCache;
  }
});

// CSRF 縱深防禦：後台 API 的非 GET 請求，若帶 Origin 需與本站同源（SameSite cookie 之外再加一層）。
// 無 Origin 標頭時放行（部分合法情境不送 Origin），避免誤擋。
const originGuard = async (c: any, next: any) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  const origin = c.req.header('Origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === c.req.header('Host'); } catch { ok = false; }
    if (!ok) return c.json({ error: 'bad origin' }, 403);
  }
  return next();
};
app.use('/api/admin/*', originGuard);

// 後台 API（管理者認證 + CRUD）
app.route('/api/admin', admin);

// R2 檔案服務（公開；附件、輪播背景、公開下載檔）
// member/ 前綴為限定存取的檔案（沿用 paa-web 的權限前綴），公開端點一律拒絕。
app.get('/files/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/files\//, ''));
  if (!key || key.startsWith('member/')) return c.notFound();
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

// 將 JSON 欄位字串解析回物件（body / items / buttons / blocks / paras…）
const pj = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

// ── 健康檢查 ──────────────────────────────────────────────
app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'paa-ur-api', env: c.env.ENVIRONMENT ?? 'unknown', ts: new Date().toISOString() }));

// 前台設定（公開）：Turnstile site key 僅在後端已設 secret（即啟用驗證）時回傳。
// env 給前後台判斷是否顯示「測試站」標註——一律以這裡（c.env.ENVIRONMENT）為準，
// 不要在前端用網址字串猜。
app.get('/api/config', (c) => c.json({
  turnstileSiteKey: c.env.TURNSTILE_SECRET ? TURNSTILE_SITE_KEY : null,
  env: c.env.ENVIRONMENT ?? 'unknown',
}));

app.get('/api/health/db', async (c) => {
  const row = await c.env.DB.prepare('select count(*) as n from announcement_categories').first<{ n: number }>();
  return c.json({ ok: true, categories: row?.n ?? 0 });
});

// ── 公告（公開）──────────────────────────────────────────
// 支援 ?category=（分類名，或「全部」）、?q=（關鍵字）、?page= &?perPage=
app.get('/api/announcements', async (c) => {
  const cat = c.req.query('category');
  const q = c.req.query('q');
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(c.req.query('perPage') || '8', 10) || 8));

  const where = ["a.visibility='public'", "a.status='published'", 'a.show_in_list=1'];
  const binds: (string | number)[] = [];
  // 分類篩選以 id 為準（前台網址 ?category=<id>）；舊的分享連結／輪播按鈕可能還帶分類名稱，保留相容。
  if (cat && cat !== '全部') {
    if (/^\d+$/.test(cat)) { where.push('c.id = ?'); binds.push(Number(cat)); }
    else { where.push('c.name = ?'); binds.push(cat); }
  }
  if (q) { where.push('(a.title LIKE ? OR a.excerpt LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }
  const whereSql = where.join(' AND ');

  const countRow = await c.env.DB
    .prepare(`select count(*) as n from announcements a join announcement_categories c on c.id=a.category_id where ${whereSql}`)
    .bind(...binds).first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `select a.id,a.title,a.excerpt,a.publish_date,a.is_pinned,a.views,c.name as category,c.color
       from announcements a join announcement_categories c on c.id=a.category_id
      where ${whereSql}
      order by a.is_pinned desc, a.publish_date desc
      limit ? offset ?`,
  ).bind(...binds, perPage, (page - 1) * perPage).all();

  return c.json({ items: results, total: countRow?.n ?? 0, page, perPage });
});

// 公告內文（公開）＋附件；順帶累加瀏覽數
app.get('/api/announcements/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400);
  const item = await c.env.DB.prepare(
    `select a.id,a.title,a.excerpt,a.body,a.publish_date,a.views,a.is_pinned,c.name as category,c.color
       from announcements a join announcement_categories c on c.id=a.category_id
      where a.id=? and a.visibility='public' and a.status='published'`,
  ).bind(id).first<Record<string, unknown>>();
  if (!item) return c.json({ error: 'not found' }, 404);
  // access='member' 的附件只吐檔名／大小，不吐 file_path（R2 key），前台據此顯示為鎖定。
  const { results: rawFiles } = await c.env.DB.prepare(
    "select id,name,file_path,size_bytes,type,access,file_date from attachments where owner_type='announcement' and owner_id=? order by sort_order",
  ).bind(id).all();
  const files = (rawFiles as any[]).map((f) => (f.access === 'member'
    ? { id: f.id, name: f.name, size_bytes: f.size_bytes, type: f.type, access: 'member', file_date: f.file_date }
    : { id: f.id, name: f.name, file_path: f.file_path, size_bytes: f.size_bytes, type: f.type, access: 'public', file_date: f.file_date }));
  background(c, c.env.DB.prepare('update announcements set views=views+1 where id=?').bind(id).run());
  item.body = pj(item.body);
  return c.json({ item: { ...item, files } });
});

// 公告分類（公開，供新聞頁分頁籤）
app.get('/api/categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    "select id,name,color from announcement_categories where scope='public' order by sort_order",
  ).all();
  return c.json({ items: results });
});

// ── 檔案下載（公開；分類「會員」整批不出現，個別檔案的會員限定僅顯示鎖定列）──
app.get('/api/downloads', async (c) => {
  const { results: raw } = await c.env.DB.prepare(
    `select d.id,d.name,d.description,d.publish_date,dc.id as category_id,dc.name as category,d.access,d.size_bytes,d.type,d.file_path
       from documents d join document_categories dc on dc.id=d.category_id
      where d.is_active=1 and dc.access_scope<>'member'
      order by dc.sort_order, d.publish_date desc, d.sort_order`, // 同分類內先比發布日期新→舊，日期相同才比排序值（小的在前）。
  ).all<Record<string, unknown>>();
  // 分類本身是「會員」（access_scope='member'）已在上面 WHERE 整批排除。
  // 個別檔案若設成 access='member'，只吐中繼資料、不吐 file_path（R2 key），比照公告附件。
  const items = raw.map((d) => (d.access === 'member' ? { ...d, file_path: undefined } : d));
  return c.json({ items });
});

// ── 友站連結 / 輪播 ─────────────────────────────────
app.get('/api/friends', async (c) => {
  const { results } = await c.env.DB.prepare(
    'select name,url from friend_links where is_active=1 order by sort_order',
  ).all();
  return c.json({ items: results });
});

app.get('/api/hero', async (c) => {
  const { results } = await c.env.DB.prepare(
    'select background_image,eyebrow,title,description,buttons from hero_slides where is_active=1 order by sort_order',
  ).all<Record<string, unknown>>();
  results.forEach((h) => { h.buttons = pj(h.buttons); });
  return c.json({ items: results });
});

// ── 法律頁面 / 聯絡資訊 ────────────────────────────────────
app.get('/api/legal/:key', async (c) => {
  const item = await c.env.DB.prepare(
    'select "key",title,title_en,updated_date,blocks,file_key from legal_pages where "key"=?',
  ).bind(c.req.param('key')).first<Record<string, unknown>>();
  if (!item) return c.json({ error: 'not found' }, 404);
  item.blocks = pj(item.blocks);
  return c.json({ item });
});

app.get('/api/contact', async (c) => {
  const row = await c.env.DB.prepare("select \"value\" as v from settings where \"key\"='contact'").first<{ v: string }>();
  return c.json({ contact: row ? pj(row.v) : null });
});

// ── 首頁聚合（一次取回 hero/sections/分類最新公告）──────
app.get('/api/home', async (c) => {
  const hero = (await c.env.DB.prepare(
    'select background_image,eyebrow,title,description,buttons from hero_slides where is_active=1 order by sort_order',
  ).all<Record<string, unknown>>()).results;
  hero.forEach((h) => { h.buttons = pj(h.buttons); });
  const sections = (await c.env.DB.prepare(
    'select "key",title,is_visible,sort_order from home_sections order by sort_order',
  ).all()).results;
  const categories = (await c.env.DB.prepare(
    "select id,name,color from announcement_categories where scope='public' order by sort_order",
  ).all<{ id: number; name: string; color: string }>()).results;

  const news: Record<string, unknown[]> = {};
  for (const cat of categories) {
    const { results } = await c.env.DB.prepare(
      `select id,title,publish_date,is_pinned from announcements
        where visibility='public' and status='published' and show_in_list=1 and category_id=?
        order by is_pinned desc, publish_date desc limit 3`,
    ).bind(cat.id).all();
    news[cat.name] = results;
  }
  // 首頁「計畫說明」（後台「計畫說明」模組維護）；未設定或內文空白則前台不顯示該區塊
  const introRow = await c.env.DB.prepare("select \"value\" as v from settings where \"key\"='home_intro'").first<{ v: string }>();
  const intro = introRow ? pj(introRow.v) : null;
  return c.json({
    hero, sections,
    intro: intro && typeof intro === 'object' && (intro as { html?: string }).html ? intro : null,
    categories: categories.map((x) => ({ id: x.id, name: x.name, color: x.color })),
    news,
  });
});

// ── CSP 違規回報（Report-Only 觀察期；記到 Worker 日誌）──────────
app.post('/api/csp-report', async (c) => {
  try { console.log('[CSP-Report]', (await c.req.text()).slice(0, 2000)); } catch { /* ignore */ }
  return c.body(null, 204);
});

// ── robots.txt（依環境 host 動態指向 sitemap）──────────────────
app.get('/robots.txt', (c) => {
  const origin = new URL(c.req.url).origin;
  // 非正式環境：整站禁止檢索（不應與正式站競爭排名）
  const body = c.env.ENVIRONMENT !== 'prod'
    ? ['User-agent: *', 'Disallow: /', ''].join('\n')
    : [
      // /api/ 不擋：前台頁面靠這些唯讀公開端點算染內容，擋 robots.txt 會讓 Googlebot
      // 算染時抓不到資料（畫面卡在「載入失敗」），害頁面被判 Soft 404、無法收錄。
      // 真正敏感的 /api/admin 本來就有 session 驗證，robots.txt 擋不到隱私。
      'User-agent: *', 'Allow: /', 'Disallow: /admin',
      '', 'Sitemap: ' + origin + '/sitemap.xml', '',
    ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
});

// ── sitemap.xml（靜態頁 + 已發布公告）──────────────
app.get('/sitemap.xml', async (c) => {
  const origin = new URL(c.req.url).origin;
  const today = new Date().toISOString().slice(0, 10);
  const lm = (v: unknown) => (v ? String(v).slice(0, 10) : today);
  const urls: { loc: string; lastmod: string }[] = [];
  for (const p of ['/', '/news', '/downloads', '/contact', '/privacy', '/terms']) urls.push({ loc: origin + p, lastmod: today });
  const anns = (await c.env.DB.prepare("select id,updated_at from announcements where visibility='public' and status='published' order by id").all()).results as any[];
  for (const a of anns) urls.push({ loc: origin + '/news/' + a.id, lastmod: lm(a.updated_at) });
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')
    + '\n</urlset>\n';
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
});

// ── 前台 SPA fallback + 每頁 meta 邊緣注入 ─────────────────────
// 採路徑式網址（/news/1、/downloads…）。靜態檔由 Assets 優先服務；
// 未命中的前台路徑在此回傳殼層 index.html，並依路徑注入每頁標題/描述/OG/JSON-LD。
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/files/')) return c.json({ error: 'not found' }, 404);
  if (p === '/admin' || p.startsWith('/admin/') || p.startsWith('/assets/')) return c.env.ASSETS.fetch(c.req.raw);
  // 前台路徑：取殼層（根路徑 '/'，避免 /index.html 被資產層 307）後注入每頁 meta
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/', url), c.req.raw));
  const meta = await resolveMeta(c.env, url);
  return injectMeta(shell, meta);
});

// ── 公告預約發布（Cron Trigger，見 wrangler.jsonc 的 triggers.crons）────────────
// status='scheduled' 且時間已到的公告，自動轉為 'published'。
//
// publish_date 是後台 <input type=datetime-local> 直接存下來的「台灣本地時間」字串
// （見 admin.ts 的 ann()，沒有轉過時區），而 SQLite 的 datetime('now') 是 UTC——
// 兩者格式雖然都是 YYYY-MM-DD HH:MM[:SS]，直接比較會誤差 8 小時。故這裡把 UTC now
// 加 8 小時換算成台灣時間再比較（台灣全年不實施日光節約時間，固定 +8 沒有例外）。
//
// UPDATE 的 WHERE 天然具備幂等性：一旦轉成 published，下一輪 cron 就不會再選到它，
// 不需要額外的重複執行保護（Cron Triggers 是 at-least-once，可能重複觸發）。
async function publishDueAnnouncements(env: Bindings): Promise<void> {
  const due = await env.DB.prepare(
    "select id, title from announcements where status='scheduled' and datetime(publish_date) <= datetime('now', '+8 hours')",
  ).all<{ id: number; title: string }>();
  if (!due.results.length) return;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const ids = due.results.map((r) => r.id);
  await env.DB.prepare(
    `update announcements set status='published', published_at=?, updated_at=? where id in (${ids.map(() => '?').join(',')})`,
  ).bind(nowStr, nowStr, ...ids).run();
  // 稽核紀錄：admin_user_id 留 null 代表系統自動觸發，供後台「操作紀錄」查得到誰（何時）發布的。
  await env.DB.batch(due.results.map((r) => env.DB.prepare(
    "insert into audit_logs (admin_user_id,action,entity_type,entity_id,changes,ip) values (null,'auto-publish','announcement',?,?,null)",
  ).bind(String(r.id), JSON.stringify({ title: r.title }))));
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(publishDueAnnouncements(env));
  },
};
