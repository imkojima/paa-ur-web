// SEO 階段 3：依路徑解析每頁 meta（標題／描述／OG 圖／JSON-LD），並以 HTMLRewriter 注入殼層。
// 供爬蟲與社群預覽取得「每則公告」正確的標題、摘要與封面。

const SITE = '澎湖縣老宅延壽機能復新計畫'; // 站名；與 web/index.html、web/assets/app.js 的 SITE_NAME 同步
const SITE_DESC = '澎湖縣老宅延壽機能復新計畫 — 補助辦法、申請流程、常見問答、線上諮詢與申請表單下載。';

type Env = { DB: D1Database };
export type PageMeta = {
  title: string; description: string; image: string; type: string;
  canonical: string; noindex: boolean; jsonld?: unknown;
};

const STATIC: Record<string, { title: string; desc: string; noindex?: boolean }> = {
  plan: { title: '計畫說明', desc: '老宅延壽機能復新計畫的緣起、推動主軸、期程與執行單位。' },
  subsidy: { title: '補助辦法', desc: '申請資格、補助項目與額度、補助比例、加碼條件及優先審查項目。' },
  process: { title: '申請流程', desc: '從提出申請、縣府審查、核定施工到成果備查與請款的步驟說明。' },
  news: { title: '最新公告', desc: '計畫相關公告、活動訊息與宣導資訊。' },
  downloads: { title: '資料下載', desc: '申請表單、說明會簡報、宣傳摺頁與相關文件下載。' },
  faq: { title: '常見問答', desc: '申請資格、補助項目、申請程序、審查作業等常見問題。' },
  consult: { title: '線上諮詢', desc: 'LINE 即時諮詢，由網路值班人員回覆。' },
  contact: { title: '聯絡我們', desc: '執行單位、主辦單位與指導單位的聯絡窗口。' },
  privacy: { title: '隱私權政策', desc: '本網站隱私權政策說明。' },
  terms: { title: '網站使用條款', desc: '本網站使用條款說明。' },
  sitemap: { title: '網站地圖', desc: '本網站頁面索引。' },
};

const full = (t: string) => (t ? `${t} ｜ ${SITE}` : SITE);
const clip = (s: unknown, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const absUrl = (u: string, origin: string) => {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return origin + (u.startsWith('/') ? u : '/' + u);
};
function bodyText(body: unknown): string {
  if (!body) return '';
  try { const j = JSON.parse(String(body)); if (Array.isArray(j)) return j.map((b: any) => b.p || b.h || (Array.isArray(b.list) ? b.list.join('、') : '')).filter(Boolean).join(' '); } catch { /* not json */ }
  return String(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function firstImage(body: unknown, origin: string): string | null {
  if (!body) return null;
  const m = String(body).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return absUrl(m[1], origin);
  try { const j = JSON.parse(String(body)); if (Array.isArray(j)) { const im = j.find((b: any) => b.img || b.image); if (im) return absUrl(im.img || im.image, origin); } } catch { /* */ }
  return null;
}
function articleJsonLd(origin: string, path: string, row: any, img: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'NewsArticle', headline: row.title, datePublished: row.publish_date || undefined,
        image: img, url: origin + path, mainEntityOfPage: origin + path,
        publisher: { '@type': 'Organization', name: SITE, logo: { '@type': 'ImageObject', url: origin + '/assets/logo.png' } },
      },
      {
        '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: '首頁', item: origin + '/' },
          { '@type': 'ListItem', position: 2, name: '最新公告', item: origin + '/news' },
          { '@type': 'ListItem', position: 3, name: row.title },
        ],
      },
    ],
  };
}

export async function resolveMeta(env: Env, url: URL): Promise<PageMeta> {
  const origin = url.origin;
  const path = url.pathname;
  const defImg = origin + '/assets/og-cover-v3.jpg';
  const base: PageMeta = { title: SITE, description: SITE_DESC, image: defImg, type: 'website', canonical: origin + path, noindex: false };
  const make = (title: string, desc: string, extra: Partial<PageMeta> = {}): PageMeta => ({ ...base, title: full(title), description: clip(desc || SITE_DESC), ...extra });

  const segs = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  // 首頁由 Assets 直接服務（靜態 index.html 已含站台級 meta 與 Organization JSON-LD），此分支僅為保險
  if (segs.length === 0) return { ...make('', SITE_DESC), canonical: origin + '/' };

  const a = decodeURIComponent(segs[0]);

  // 公告詳細 /news/<id>
  if (a === 'news' && segs[1]) {
    const id = decodeURIComponent(segs[1]);
    const row = await env.DB.prepare('select title,excerpt,body,visibility,status,publish_date from announcements where id=?').bind(id).first<any>();
    if (!row || row.visibility !== 'public' || row.status !== 'published') return make(STATIC.news.title, STATIC.news.desc, { noindex: true });
    const img = firstImage(row.body, origin) || defImg;
    return {
      ...base, title: full(row.title), description: clip(row.excerpt || bodyText(row.body) || STATIC.news.desc),
      image: img, type: 'article', canonical: origin + '/news/' + id, jsonld: articleJsonLd(origin, '/news/' + id, row, img),
    };
  }
  if (a === 'news') return make(STATIC.news.title, STATIC.news.desc, { canonical: origin + '/news' });

  const sm = STATIC[a];
  if (sm) return make(sm.title, sm.desc, sm.noindex ? { noindex: true } : {});

  // 未知前台路徑：站台預設 + noindex（軟 404）
  return make('', SITE_DESC, { noindex: true });
}

const escAttr = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 以 HTMLRewriter 將每頁 meta 注入殼層 index.html（改寫既有標籤，避免重複）
export function injectMeta(res: Response, m: PageMeta): Response {
  let head = '';
  if (m.noindex) head += `<meta name="robots" content="noindex,follow">`;
  if (m.jsonld) head += `\n<script type="application/ld+json">${JSON.stringify(m.jsonld).replace(/</g, '\\u003c')}</script>`;
  const rw = new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(m.title); } })
    .on('meta[name="description"]', { element(e) { e.setAttribute('content', m.description); } })
    .on('link[rel="canonical"]', { element(e) { e.setAttribute('href', m.canonical); } })
    .on('meta[property="og:url"]', { element(e) { e.setAttribute('content', m.canonical); } })
    .on('meta[property="og:title"]', { element(e) { e.setAttribute('content', m.title); } })
    .on('meta[property="og:description"]', { element(e) { e.setAttribute('content', m.description); } })
    .on('meta[property="og:image"]', { element(e) { e.setAttribute('content', m.image); } })
    .on('meta[property="og:type"]', { element(e) { e.setAttribute('content', m.type); } })
    .on('meta[name="twitter:title"]', { element(e) { e.setAttribute('content', m.title); } })
    .on('meta[name="twitter:description"]', { element(e) { e.setAttribute('content', m.description); } })
    .on('meta[name="twitter:image"]', { element(e) { e.setAttribute('content', m.image); } });
  if (head) rw.on('head', { element(e) { e.append(head, { html: true }); } });
  return rw.transform(res);
}
