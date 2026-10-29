// PAA-UR — vanilla SPA. Public pages fetch from the Cloudflare Worker API (/api/*,
// same origin). All navigation flows through go(page, arg).

(() => {
  // ── tiny DOM helper ──────────────────────────────────────────────────────
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'className') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'disabled') { if (v) e.disabled = true; }
        else e.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  // ── API client (same-origin /api/*) ──────────────────────────────────────
  async function api(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('API ' + r.status + ' ' + path);
    return r.json();
  }
  const _cache = new Map();
  function apiCached(path) {
    if (!_cache.has(path)) _cache.set(path, api(path).catch((e) => { _cache.delete(path); throw e; }));
    return _cache.get(path);
  }

  // 測試站標註：抓 /api/config 的 env（後端 c.env.ENVIRONMENT 為準，見 index.ts），
  // 非 prod 時在頁首會名與瀏覽器標題加註「（測試）」。Header()/applyMeta() 不是 reactive
  // 的，資料晚到不會自動補畫，所以必須在第一次 applyRoute() 之前就把值準備好（見檔尾）。
  let siteEnv = 'prod';
  const testTag = () => (siteEnv === 'prod' ? '' : '（測試）');
  const qs = (o) => Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  // ISO 'YYYY-MM-DD' → ROC dotted '115.05.28' (markup/rocDate expect dotted ROC)
  const isoToRoc = (iso) => {
    if (!iso) return '';
    const p = String(iso).slice(0, 10).split('-'); // 僅取日期部分（publish_date 可能含時:分）
    if (p.length !== 3) return String(iso);
    return (Number(p[0]) - 1911) + '.' + p[1] + '.' + p[2];
  };
  // Cloudflare Image Transformations：自訂網域才啟用（workers.dev/本機回原圖，等於 no-op）。
  // 正式網域上線後於 zone 啟用 Image Transformations 即自動生效，前端不需再改。
  const imgUrl = (src, w) => {
    if (!src) return src;
    const host = location.hostname;
    if (host.endsWith('.workers.dev') || host === 'localhost' || host === '127.0.0.1') return src;
    if (/^https?:\/\//i.test(src)) return src; // 外部圖維持原樣
    const s = src.charAt(0) === '/' ? src : '/' + src;
    return '/cdn-cgi/image/width=' + w + ',quality=80,format=auto' + s;
  };
  const fmtBytes = (n) => {
    if (n == null) return '';
    if (n >= 1048576) return (n / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  };

  const store = {
    categories: () => apiCached('/api/categories').then((r) => r.items),
    home: () => api('/api/home'),
    news: (params) => api('/api/announcements?' + qs(params)),
    newsAll: () => api('/api/announcements?perPage=100'),
    article: (id) => api('/api/announcements/' + encodeURIComponent(id)),
    downloads: () => apiCached('/api/downloads'),
    friends: () => apiCached('/api/friends'),
    hero: () => apiCached('/api/hero'),
    legal: (key) => apiCached('/api/legal/' + key),
    contact: () => apiCached('/api/contact'),
  };

  // Per-route teardown registry (carousel interval).
  let timers = [];
  function clearTimers() { timers.forEach(clearInterval); timers = []; }
  let teardowns = [];
  function clearTeardowns() { teardowns.forEach((fn) => fn()); teardowns = []; }

  const root = document.getElementById('root');
  let route = { page: 'home', arg: null };

  // 主選單（前端執行期設定；其餘 demo 資料已移至 api/seeds/demo-data.js）
  const PAA_NAV = [
    { id: 'home', label: '首頁' },
    { id: 'news', label: '最新公告' },
    { id: 'downloads', label: '檔案下載' },
    { id: 'contact', label: '聯絡我們' },
  ];

  // ── 每頁標題／描述（SEO 階段 1：前端動態 <title> 與 description）─────────────
  const SITE_NAME = '社團法人澎湖縣建築師公會';
  const DEFAULT_DESC = '社團法人澎湖縣建築師公會官方網站 — 最新公告、檔案下載與聯絡資訊。';
  const PAGE_TITLES = {
    home: '', news: '最新公告', downloads: '檔案下載', contact: '聯絡我們',
    privacy: '隱私權政策', terms: '網站使用條款', sitemap: '網站地圖', article: '最新公告',
  };
  function applyMeta(r, view) {
    let t = PAGE_TITLES[r.page] || '';
    // 詳細頁：直接從已渲染的 DOM 取標題（公告），無需改各頁函式
    if (view && view.querySelector) {
      const art = view.querySelector('.paa-article-title');
      if (art && art.textContent.trim()) t = art.textContent.trim();
      else if ((r.page === 'news' || r.page === 'downloads') && r.arg) {
        // 分類頁：網址帶的是分類 id，名稱從已渲染的分類 tab 取
        const tab = view.querySelector('.paa-news-tab-active');
        if (tab && tab.textContent.trim() && tab.textContent.trim() !== '全部') t = tab.textContent.trim();
      }
    }
    document.title = (t ? (t + ' ｜ ' + SITE_NAME) : SITE_NAME) + testTag();
    const m = document.querySelector('meta[name="description"]');
    if (m) m.setAttribute('content', DEFAULT_DESC);
  }

  // ── 路徑式路由（History API）─────────────────────────────────────────────
  // 內部仍以 {page, arg} 表示；序列化規則：
  //   home→/  news→/news（分類用 ?category=）  article→/news/<id>
  //   downloads→/downloads（分類用 ?category=）  其餘→/<page>
  function routeToPath(r) {
    if (!r || !r.page || r.page === 'home') return '/';
    if (r.page === 'article') return '/news/' + encodeURIComponent(r.arg);
    if (r.page === 'news') return r.arg ? '/news?category=' + encodeURIComponent(r.arg) : '/news';
    if (r.page === 'downloads') return r.arg ? '/downloads?category=' + encodeURIComponent(r.arg) : '/downloads';
    return '/' + r.page;
  }
  function pathToRoute(loc) {
    const segs = (loc.pathname || '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const params = new URLSearchParams(loc.search || '');
    if (segs.length === 0) return { page: 'home', arg: null };
    const a = decodeURIComponent(segs[0]);
    if (a === 'news') return segs[1] ? { page: 'article', arg: decodeURIComponent(segs[1]) } : { page: 'news', arg: params.get('category') };
    if (a === 'downloads') return { page: 'downloads', arg: params.get('category') };
    return { page: a, arg: segs[1] ? decodeURIComponent(segs[1]) : null };
  }
  // 相容舊的 #/ 連結（已分享出去的網址）：解析成 {page,arg} 再轉新路徑
  function legacyHashToRoute(hash) {
    const raw = String(hash).replace(/^#\/?/, '');
    if (!raw) return { page: 'home', arg: null };
    const slash = raw.indexOf('/');
    if (slash === -1) return { page: decodeURIComponent(raw), arg: null };
    return { page: decodeURIComponent(raw.slice(0, slash)), arg: decodeURIComponent(raw.slice(slash + 1)) };
  }
  function applyRoute() { route = pathToRoute(location); render(); }
  function go(page, arg = null) {
    const path = routeToPath({ page, arg });
    if (location.pathname + location.search === path) { applyRoute(); return; }
    history.pushState({}, '', path);
    applyRoute();
  }
  // 頁內切換（分類 tab）只改網址不重新渲染：用 replaceState 免得每切一次 tab 就多一筆歷程，
  // 但網址列要跟著變，複製出去分享才會落在同一個分類。
  function setUrl(page, arg = null, view) {
    const path = routeToPath({ page, arg });
    if (location.pathname + location.search !== path) history.replaceState({}, '', path);
    route = pathToRoute(location);
    if (view) applyMeta(route, view);
  }
  // 分類參數（網址 ?category= 或輪播按鈕的參數）以 id 為準；舊連結可能帶分類名稱，也接受。
  function findCat(cats, key) {
    if (key == null || key === '') return null;
    const k = String(key);
    return cats.find((c) => String(c.id) === k) || cats.find((c) => c.name === k) || null;
  }
  // 產生真正的 <a> 站內連結（爬蟲可爬、可 Cmd/中鍵開新分頁）；點擊由全域攔截器走前端路由
  function link(page, arg, attrs, ...kids) {
    return h('a', Object.assign({ href: routeToPath({ page, arg }), 'data-link': '1' }, attrs || {}), ...kids);
  }

  // ── chrome: header / nav / drawer ────────────────────────────────────────
  // 測試站橫幅：比頁首那句「（測試）」明顯得多，放在整個頁面最上方、頁首正上面。
  function TestBanner() {
    return h('div', { className: 'paa-testbanner' }, '⚠ 這是測試站，非本會正式網站，資料僅供測試');
  }

  function Header(page) {
    let menuOpen = false;
    const activeId = page === 'article' ? 'news' : page;

    const ham = h('button', { className: 'paa-hamburger', 'aria-label': '選單',
      onClick: () => { menuOpen = !menuOpen; sync(); } },
      h('span'), h('span'), h('span'));

    const drawer = h('div', { className: 'paa-drawer' },
      PAA_NAV.map((n) => link(n.id, null, {
        className: 'paa-drawer-item' + (activeId === n.id ? ' paa-drawer-active' : '') + (n.accent ? ' paa-drawer-accent' : ''),
      }, h('span', null, n.label))));

    const backdrop = h('div', { className: 'paa-drawer-backdrop',
      onClick: () => { menuOpen = false; sync(); } });

    function sync() {
      Array.from(ham.children).forEach((s) => { s.className = menuOpen ? 'paa-ham-x' : ''; });
      drawer.className = 'paa-drawer' + (menuOpen ? ' paa-drawer-open' : '');
      backdrop.style.display = menuOpen ? '' : 'none';
    }
    backdrop.style.display = 'none';

    const util = h('div', { className: 'paa-utility-links' },
      link('sitemap', null, null, '網站導覽'),
      h('span', { className: 'paa-util-sep' }, '|'),
      link('contact', null, null, '聯絡我們'));

    return h('header', { className: 'paa-header-root' },
      h('div', { className: 'paa-utility' },
        h('div', { className: 'paa-wrap paa-utility-inner' },
          h('div', { className: 'paa-utility-org' }, '社團法人澎湖縣建築師公會' + testTag() + '　PENGHU ARCHITECTS ASSOCIATION'),
          util)),
      h('div', { className: 'paa-brandrow' },
        h('div', { className: 'paa-wrap paa-brandrow-inner' },
          link('home', null, { className: 'paa-brand' },
            h('img', { className: 'paa-brand-mark', src: 'assets/logo.png', alt: '社團法人澎湖縣建築師公會 會徽', width: '54', height: '54' }),
            h('span', { className: 'paa-brand-text' },
              h('span', { className: 'paa-brand-zh' }, '社團法人澎湖縣建築師公會'),
              h('span', { className: 'paa-brand-en' }, 'PENGHU ARCHITECTS ASSOCIATION'))),
          ham)),
      h('nav', { className: 'paa-nav' },
        h('div', { className: 'paa-wrap paa-nav-inner' },
          PAA_NAV.map((n) => link(n.id, null, {
            className: 'paa-nav-item' + (activeId === n.id ? ' paa-nav-active' : '') + (n.accent ? ' paa-nav-accent' : ''),
          }, h('span', { className: 'paa-nav-zh' }, n.label))))),
      drawer,
      backdrop);
  }

  function Breadcrumb(trail) {
    const inner = h('div', { className: 'paa-wrap paa-breadcrumb-inner' });
    trail.forEach((t, i) => {
      if (i > 0) inner.appendChild(h('span', { className: 'paa-bc-sep' }, '›'));
      const last = i === trail.length - 1;
      if (!last && t.page) inner.appendChild(link(t.page, t.arg || null, { className: 'paa-bc-link' }, t.label));
      else inner.appendChild(h('span', { className: last ? 'paa-bc-current' : 'paa-bc-link', onClick: t.onClick }, t.label));
    });
    return h('div', { className: 'paa-breadcrumb' }, inner);
  }

  function Heading(zh, en) {
    return h('div', { className: 'paa-secheading' },
      h('h2', { className: 'paa-secheading-zh' }, zh),
      h('span', { className: 'paa-secheading-en' }, en));
  }

  function PageBanner(zh, en) {
    return h('div', { className: 'paa-page-banner' },
      h('div', { className: 'paa-wrap' },
        h('h1', { className: 'paa-page-banner-zh' }, zh),
        h('span', { className: 'paa-page-banner-en' }, en)));
  }

  // 從檔案清單推導分類（依 API 回傳順序＝後台排序）；同名分類以 id 區分
  function uniqCats(items) {
    const seen = new Set(); const out = [];
    for (const f of items || []) {
      if (!f.category || seen.has(f.category_id)) continue;
      seen.add(f.category_id); out.push({ id: f.category_id, name: f.category });
    }
    return out;
  }
  function archiveCard(f, page, arg) {
    return link(page, arg, { className: 'paa-archive-card' },
      h('span', { className: 'paa-archive-doc' },
        h('span', { className: 'paa-archive-doc-bar' }),
        h('span', { className: 'paa-archive-doc-pdf' }, 'PDF')),
      h('span', { className: 'paa-archive-text' },
        h('span', { className: 'paa-archive-t' }, f.t),
        f.d ? h('span', { className: 'paa-archive-d' }, f.d) : null,
        h('span', { className: 'paa-archive-n' }, '📎 ' + f.n + ' 份檔案')));
  }

  function renderBlocks(body) {
    return body.map((blk) => {
      if (blk.h) return h('h3', { className: 'paa-art-h' }, blk.h);
      if (blk.p) return h('p', { className: 'paa-art-p' }, blk.p);
      if (blk.list) return h('ul', { className: 'paa-art-ul' }, blk.list.map((li) => h('li', null, li)));
      if (blk.table) return h('table', { className: 'paa-art-table' },
        h('tbody', null, blk.table.map((row) => h('tr', null, h('th', null, row[0]), h('td', null, row[1])))));
      return null;
    });
  }

  // 內文渲染：字串→視為 HTML（後台 Quill 產生，輕量淨化後輸出）；陣列→沿用區塊渲染（相容舊資料）
  function sanitizeHtml(html) {
    const t = document.createElement('div');
    t.innerHTML = String(html == null ? '' : html);
    t.querySelectorAll('script,style,iframe,object,embed,form').forEach((n) => n.remove());
    t.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
      });
    });
    // 內文圖片：延遲載入＋非同步解碼（P4）
    t.querySelectorAll('img').forEach((im) => { im.setAttribute('loading', 'lazy'); im.setAttribute('decoding', 'async'); });
    return t.innerHTML;
  }
  function renderBody(body) {
    if (typeof body === 'string') return [h('div', { html: sanitizeHtml(body) })];
    return renderBlocks(body || []);
  }

  // Attachment block (files: {name, size, type, url?, locked?}).
  // locked = 限定存取（後端不吐 R2 key）：顯示檔名但不給下載。
  function articleFiles(files) {
    if (!files || !files.length) return null;
    const note = h('div', { className: 'paa-files-note' }, '＊此附件尚未上傳實體檔案，敬請見諒。');
    note.style.display = 'none';
    return h('div', { className: 'paa-article-files' },
      h('div', { className: 'paa-files-title' }, '附件下載'),
      files.map((f) => {
        const ty = (f.type || 'pdf').toUpperCase();
        const tc = { PDF: '#a53030', DOC: '#1f3a5f', XLS: '#2d6a4f', IMG: '#b8924a' }[ty] || '#7a7d82';
        const locked = !f.url && !!f.locked;
        const inner = [
          h('span', { className: 'paa-file-ic', style: { background: locked ? '#7a7d82' : tc } }, ty),
          h('span', { className: 'paa-file-name' }, f.name),
          f.date ? h('span', { className: 'paa-file-date' }, '更新 ' + f.date) : null,
          h('span', { className: 'paa-file-size' }, f.size),
          h('span', { className: 'paa-file-dl' }, locked ? '🔒 未開放' : '下載 ↓'),
        ];
        if (f.url) return h('a', { className: 'paa-file-row', href: f.url, target: '_blank', rel: 'noopener noreferrer', download: dlName(f.name, f.url) }, inner);
        if (locked) return h('button', { className: 'paa-file-row paa-file-locked', disabled: true }, inner);
        return h('button', { className: 'paa-file-row', onClick: () => { note.style.display = ''; } }, inner);
      }),
      note);
  }

  function Footer() {
    const cols = [
      { links: [['最新公告', 'news'], ['檔案下載', 'downloads'], ['聯絡我們', 'contact']] },
    ];
    return h('footer', { className: 'paa-footer' },
      h('div', { className: 'paa-wrap paa-footer-inner' },
        h('div', { className: 'paa-footer-main' },
          h('div', { className: 'paa-footer-brand' },
            h('img', { className: 'paa-footer-mark', src: 'assets/logo.png', alt: '社團法人澎湖縣建築師公會 會徽', width: '46', height: '46', loading: 'lazy' }),
            h('span', null, '社團法人澎湖縣建築師公會')),
          h('div', { className: 'paa-footer-info', html:
            '會址：澎湖縣馬公市中興路13號<br>電話：(06) 927-1112　傳真：(06) 927-1132<br>電子郵件：penghu9271112@gmail.com' })),
        cols.map((c) => h('div', { className: 'paa-footer-col' },
          c.t ? h('div', { className: 'paa-footer-coltitle' }, c.t) : null,
          c.links.map(([label, page]) => link(page, null, { className: 'paa-footer-link' }, label))))),
      h('div', { className: 'paa-footer-legal' },
        h('div', { className: 'paa-wrap paa-footer-legal-inner' },
          h('div', { className: 'paa-footer-legal-links' },
            link('privacy', null, null, '隱私權政策'),
            h('span', { className: 'paa-legal-sep' }, '·'),
            link('terms', null, null, '網站使用條款'),
            h('span', { className: 'paa-legal-sep' }, '·'),
            link('sitemap', null, null, '網站導覽')),
          h('div', { className: 'paa-footer-legal-copy' }, '© 2026 Penghu Architects Association. All rights reserved.'))));
  }

  // ── hero carousel ────────────────────────────────────────────────────────
  function heroSlide(s) {
    const layers = [];
    if (s.bg) {
      layers.push(h('div', { className: 'paa-hero-bg', style: { backgroundImage: 'url(' + s.bg + ')' } }));
      layers.push(h('div', { className: 'paa-hero-ov' }));
    } else {
      layers.push(h('div', { className: 'paa-hero-bg paa-hero-bg-grid' }));
    }
    layers.push(h('div', { className: 'paa-wrap paa-hero-inner' },
      s.eyebrow ? h('div', { className: 'paa-hero-eyebrow' }, s.eyebrow) : null,
      h('h1', { className: 'paa-hero-title', html: s.title }),
      s.desc ? h('p', { className: 'paa-hero-sub', html: s.desc }) : null,
      (s.buttons && s.buttons.length)
        ? h('div', { className: 'paa-hero-actions' },
            s.buttons.map((bn) => bn.url
              ? h('a', { className: bn.primary ? 'paa-btn-accent' : 'paa-btn-outline-light', href: bn.url, target: '_blank', rel: 'noopener noreferrer' }, bn.label)
              : link(bn.page, bn.arg || null, { className: bn.primary ? 'paa-btn-accent' : 'paa-btn-outline-light' }, bn.label)))
        : null));
    return layers;
  }

  function Hero(slides) {
    let active = 0, paused = false;
    const stage = h('div', { className: 'paa-hero-stage' });
    const dotBtns = slides.map((s, i) =>
      h('button', { 'aria-label': '第 ' + (i + 1) + ' 張', onClick: () => goSlide(i) }));
    const dotsWrap = h('div', { className: 'paa-hero-dots' }, dotBtns);

    function renderStage() {
      stage.innerHTML = '';
      heroSlide(slides[active]).forEach((n) => stage.appendChild(n));
      dotBtns.forEach((b, i) => { b.className = i === active ? 'paa-dot-active' : ''; });
    }
    function goSlide(i) { active = (i + slides.length) % slides.length; renderStage(); }

    const section = h('section', { className: 'paa-hero' },
      stage,
      h('button', { className: 'paa-hero-arrow paa-hero-arrow-prev', 'aria-label': '上一張', onClick: () => goSlide(active - 1) }, '‹'),
      h('button', { className: 'paa-hero-arrow paa-hero-arrow-next', 'aria-label': '下一張', onClick: () => goSlide(active + 1) }, '›'),
      dotsWrap);
    section.addEventListener('mouseenter', () => { paused = true; });
    section.addEventListener('mouseleave', () => { paused = false; });
    timers.push(setInterval(() => { if (!paused) goSlide(active + 1); }, 6000));
    renderStage();
    return section;
  }

  const heroShape = (s) => ({
    bg: s.background_image, eyebrow: s.eyebrow, title: s.title, desc: s.description,
    buttons: (s.buttons || []).map((b) => ({ label: b.label, page: b.target_page, arg: b.target_arg, url: b.url, primary: b.is_primary })),
  });

  // ── home page ────────────────────────────────────────────────────────────
  async function Home() {
    const [home, downloads, friends] = await Promise.all([
      store.home(), store.downloads(), store.friends(),
    ]);
    const dlCats = uniqCats(downloads.items);

    return h('div', { className: 'paa-home' },
      Hero(home.hero.map(heroShape)),

      h('section', { className: 'paa-wrap paa-home-mid' },
        h('div', { className: 'paa-news-head' },
          link('news', null, { className: 'paa-secheading paa-secheading-link' },
            h('h2', { className: 'paa-secheading-zh' }, '最新公告'),
            h('span', { className: 'paa-secheading-en' }, 'LATEST NEWS')),
          link('news', null, { className: 'paa-news-more' }, '更多公告 +')),
        h('div', { className: 'paa-catnews-grid paa-catnews-grid-' + Math.min(home.categories.length, 6) },
          home.categories.slice(0, 6).map((cat) => {
            const items = home.news[cat.name] || [];
            return h('div', { className: 'paa-catnews-col' },
              link('news', cat.id, { className: 'paa-catnews-head', style: { borderTopColor: cat.color } },
                h('span', { className: 'paa-catnews-dot', style: { background: cat.color } }),
                h('span', { className: 'paa-catnews-cat' }, cat.name),
                h('span', { className: 'paa-catnews-arrow' }, '›')),
              items.length
                ? h('div', { className: 'paa-catnews-list' },
                    items.map((item) => link('article', item.id, { className: 'paa-catnews-row' },
                      h('span', { className: 'paa-catnews-meta' },
                        item.is_pinned ? h('span', { className: 'paa-pin' }, '置頂') : null,
                        h('span', { className: 'paa-catnews-date' }, isoToRoc(item.publish_date))),
                      h('span', { className: 'paa-catnews-title' }, item.title))))
                : h('div', { className: 'paa-catnews-empty' }, '尚無公告'));
          }))),

      h('section', { className: 'paa-wrap paa-archive' },
        link('downloads', null, { className: 'paa-secheading paa-secheading-link' },
          h('h2', { className: 'paa-secheading-zh' }, '檔案下載'),
          h('span', { className: 'paa-secheading-en' }, 'DOWNLOADS')),
        h('div', { className: 'paa-archive-grid' },
          dlCats.map((ct) => archiveCard(
            { t: ct.name, n: downloads.items.filter((f) => f.category_id === ct.id).length },
            'downloads', ct.id)))),

      h('section', { className: 'paa-friends' },
        h('div', { className: 'paa-wrap' },
          h('div', { className: 'paa-friends-head' },
            h('span', { className: 'paa-friends-title' }, '相關連結'),
            h('span', { className: 'paa-friends-en' }, 'RELATED LINKS'),
            h('span', { className: 'paa-friends-rule' })),
          h('div', { className: 'paa-friends-grid' },
            friends.items.map((f) => f.url
              ? h('a', { className: 'paa-friend', href: f.url, target: '_blank', rel: 'noopener noreferrer' },
                  f.name, h('span', { className: 'paa-friend-ext' }, '↗'))
              : h('button', { className: 'paa-friend paa-friend-pending', title: '外部連結建置中', onClick: () => {} }, f.name))))));
  }

  // ── news list page ───────────────────────────────────────────────────────
  async function NewsList(initialCat) {
    const catsData = await store.categories();
    // cat：目前分類物件 {id,name,color}；null＝全部
    let cat = findCat(catsData, initialCat), query = '', submitted = '', page = 1;
    const perPage = 8;

    const container = h('div', { className: 'paa-page' });
    container.appendChild(Breadcrumb([{ label: '首頁', page: 'home' }, { label: '最新公告' }]));
    container.appendChild(PageBanner('最新公告', 'LATEST NEWS & ANNOUNCEMENTS'));
    const host = h('div'); container.appendChild(host);

    async function rebuild() {
      const data = await store.news({ category: cat ? cat.id : '', q: submitted.trim(), page, perPage });
      const total = data.total;
      const shown = data.items;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const body = h('div', { className: 'paa-wrap paa-news-body' });

      const input = h('input', { type: 'text', placeholder: '輸入關鍵字搜尋公告標題…', value: query,
        onInput: (e) => { query = e.target.value; },
        onKeyDown: (e) => { if (e.key === 'Enter') runSearch(); } });
      const search = h('div', { className: 'paa-news-search' },
        h('div', { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7a7d82" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>' }).firstElementChild,
        input,
        submitted ? h('button', { className: 'paa-news-search-clear', 'aria-label': '清除', onClick: clearSearch }, '×') : null);
      body.appendChild(h('div', { className: 'paa-news-searchrow' },
        search, h('button', { className: 'paa-news-search-btn', onClick: runSearch }, '搜尋')));

      body.appendChild(h('div', { className: 'paa-news-tabs' },
        [null, ...catsData].map((c) => h('button', {
          className: 'paa-news-tab' + (cat === c ? ' paa-news-tab-active' : ''),
          onClick: () => pickCat(c),
        }, c ? h('span', { className: 'paa-tab-dot', style: { background: c.color } }) : null, c ? c.name : '全部')),
        h('span', { className: 'paa-news-count' }, '共 ' + total + ' 筆')));

      if (submitted.trim()) {
        body.appendChild(h('div', { className: 'paa-news-resultnote' },
          h('span', { html: '關鍵字「<strong>' + escapeHtml(submitted.trim()) + '</strong>」的搜尋結果，共 ' + total + ' 筆' }),
          h('button', { onClick: clearSearch }, '清除搜尋')));
      }

      const list = h('div', { className: 'paa-newslist' });
      if (shown.length === 0) list.appendChild(h('div', { className: 'paa-news-empty' }, '查無符合條件的公告，請調整關鍵字或分類。'));
      shown.forEach((item) => {
        const d = isoToRoc(item.publish_date);
        list.appendChild(link('article', item.id, { className: 'paa-newslist-row' },
          h('div', { className: 'paa-newslist-date' },
            h('span', { className: 'paa-newslist-d-day' }, d.split('.').slice(1).join('/')),
            h('span', { className: 'paa-newslist-d-year' }, '民國 ' + d.split('.')[0] + ' 年')),
          h('div', { className: 'paa-newslist-main' },
            h('div', { className: 'paa-newslist-meta' },
              h('span', { className: 'paa-news-tag', style: { background: item.color } }, item.category),
              item.is_pinned ? h('span', { className: 'paa-pin' }, '置頂') : null,
              h('span', { className: 'paa-newslist-views' }, '瀏覽 ' + item.views)),
            h('div', { className: 'paa-newslist-title' }, item.title),
            h('div', { className: 'paa-newslist-excerpt' }, item.excerpt)),
          h('div', { className: 'paa-newslist-arrow' }, '→')));
      });
      body.appendChild(list);

      body.appendChild(h('div', { className: 'paa-pagination' },
        h('button', { className: 'paa-pg-btn', disabled: page === 1, onClick: () => { page = Math.max(1, page - 1); rebuild(); } }, '‹ 上一頁'),
        Array.from({ length: totalPages }).map((_, i) =>
          h('button', { className: 'paa-pg-num' + (page === i + 1 ? ' paa-pg-active' : ''), onClick: () => { page = i + 1; rebuild(); } }, i + 1)),
        h('button', { className: 'paa-pg-btn', disabled: page === totalPages, onClick: () => { page = Math.min(totalPages, page + 1); rebuild(); } }, '下一頁 ›')));

      host.innerHTML = ''; host.appendChild(body);
    }
    async function pickCat(c) { cat = c; page = 1; await rebuild(); setUrl('news', cat ? cat.id : null, container); }
    function runSearch() { submitted = query; page = 1; rebuild(); }
    function clearSearch() { query = ''; submitted = ''; page = 1; rebuild(); }

    await rebuild();
    return container;
  }

  // ── article page ─────────────────────────────────────────────────────────
  async function Article(id) {
    const [detail, listData] = await Promise.all([store.article(id), store.newsAll()]);
    const item = detail.item;
    const list = listData.items;
    const idx = list.findIndex((n) => n.id === item.id);
    const prev = list[idx - 1], next = list[idx + 1];
    // 沒填內文就留白：補一段「內容整理中」的樣板文字，讀者得讀完才發現沒有資訊，
    // 比空白更擾人。摘要若有就當內文用——那是承辦人真的打過的字。
    const body = (item.body && item.body.length) ? item.body : (item.excerpt ? [{ p: item.excerpt }] : []);
    const files = (item.files || []).map((f) => ({
      name: f.name, size: fmtBytes(f.size_bytes), type: f.type, date: isoToRoc(f.file_date),
      url: f.file_path ? '/files/' + f.file_path : null,
      locked: f.access === 'member',
    }));
    const d = isoToRoc(item.publish_date).split('.');

    return h('div', { className: 'paa-page' },
      Breadcrumb([
        { label: '首頁', page: 'home' },
        { label: '最新公告', page: 'news' },
        { label: item.category },
      ]),
      h('div', { className: 'paa-wrap paa-article' },
        h('article', { className: 'paa-article-main' },
          h('div', { className: 'paa-article-head' },
            h('span', { className: 'paa-news-tag', style: { background: item.color } }, item.category),
            h('h1', { className: 'paa-article-title' }, item.title),
            h('div', { className: 'paa-article-meta' },
              h('span', null, '發布日期：民國 ' + d[0] + ' 年 ' + d[1] + ' 月 ' + d[2] + ' 日'))),
          h('div', { className: 'paa-article-body' }, renderBody(body)),
          articleFiles(files),
          h('div', { className: 'paa-article-nav' },
            prev
              ? link('article', prev.id, { className: 'paa-artnav' },
                  h('span', { className: 'paa-artnav-dir' }, '‹ 上一則'),
                  h('span', { className: 'paa-artnav-title' }, prev.title))
              : h('button', { className: 'paa-artnav', disabled: true },
                  h('span', { className: 'paa-artnav-dir' }, '‹ 上一則'),
                  h('span', { className: 'paa-artnav-title' }, '已是最新一則')),
            next
              ? link('article', next.id, { className: 'paa-artnav paa-artnav-next' },
                  h('span', { className: 'paa-artnav-dir' }, '下一則 ›'),
                  h('span', { className: 'paa-artnav-title' }, next.title))
              : h('button', { className: 'paa-artnav paa-artnav-next', disabled: true },
                  h('span', { className: 'paa-artnav-dir' }, '下一則 ›'),
                  h('span', { className: 'paa-artnav-title' }, '已是最後一則'))),
          h('div', { className: 'paa-article-back' },
            h('button', { className: 'paa-btn-ghost', onClick: () => go('news') }, '← 返回公告列表'))),
        h('aside', { className: 'paa-article-side' },
          h('div', { className: 'paa-side-title' }, '近期公告'),
          h('div', { className: 'paa-side-list' },
            list.filter((n) => n.id !== item.id).slice(0, 6).map((n) =>
              link('article', n.id, { className: 'paa-side-row' },
                h('span', { className: 'paa-side-tag', style: { color: n.color } }, n.category),
                h('span', { className: 'paa-side-row-title' }, n.title),
                h('span', { className: 'paa-side-row-date' }, isoToRoc(n.publish_date))))))));
  }

  // 下載時要顯示的檔名：後台設定的「檔名」通常不含副檔名（如「115年度會員大會會議記錄」），
  // 直接拿來當下載檔名，Windows 會因為沒有副檔名而不知道用什麼開啟。這裡從實體檔網址補回來。
  function dlName(name, url) {
    if (!name) return '';
    const m = String(url || '').match(/\.([a-z0-9]{1,8})(?:$|[?#])/i);
    if (!m) return name;
    return new RegExp('\\.' + m[1] + '$', 'i').test(name) ? name : name + '.' + m[1];
  }

  // ── file list page (檔案下載) ─────────────────────────────────────────────
  function fileRow(f, flash) {
    const ty = (f.type || 'pdf').toUpperCase();
    const tc = { PDF: '#a53030', DOC: '#1f3a5f', XLS: '#2d6a4f', IMG: '#b8924a' }[ty] || '#7a7d82';
    const member = f.access === 'member';
    const inner = [
      h('span', { className: 'paa-dlfile-ic', style: { background: tc } }, ty),
      h('span', { className: 'paa-dlfile-name' }, f.name),
      member ? h('span', { className: 'paa-dlfile-badge paa-badge-member' }, '未開放') : null,
      h('span', { className: 'paa-dlfile-size' }, f.size),
      h('span', { className: 'paa-dlfile-act' }, member ? '🔒 未開放' : '下載 ↓'),
    ];
    // 公開且有實體檔 → 真實下載
    if (!member && f.url) {
      return h('a', { className: 'paa-dlfile', href: f.url, target: '_blank', rel: 'noopener noreferrer', download: dlName(f.name, f.url) }, inner);
    }
    return h('button', { className: 'paa-dlfile' + (member ? ' paa-dlfile-member' : ''),
      onClick: () => flash(member
        ? '「' + f.name + '」目前未開放下載。'
        : '「' + f.name + '」尚未上傳檔案。') }, inner);
  }

  function FileListPage(cfg) {
    // 分類以 id 識別（cfg.files[].catId），null＝全部；initialCat 接受 id 或舊的分類名稱
    const cats = uniqCats(cfg.files.map((f) => ({ category_id: f.catId, category: f.cat })));
    let cat = findCat(cats, cfg.initialCat);
    const container = h('div', { className: 'paa-page' });
    const noteDesc = h('div', { className: 'paa-loginbanner-d' });
    const note = h('div', { className: 'paa-loginbanner' },
      h('span', { className: 'paa-loginbanner-ic' }, 'ℹ️'),
      h('div', { className: 'paa-loginbanner-text' }, h('div', { className: 'paa-loginbanner-t' }, '提醒'), noteDesc));
    note.style.marginTop = '14px';
    note.style.display = 'none';
    const flash = (msg) => {
      noteDesc.textContent = msg;
      note.style.display = '';
      note.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    function rebuild() {
      note.style.display = 'none';
      const list = cat ? cfg.files.filter((f) => f.catId === cat.id) : cfg.files;
      const body = h('div', { className: 'paa-wrap paa-dl-body' },
        cfg.intro ? h('p', { className: 'paa-dl-intro' }, cfg.intro) : null,
        h('div', { className: 'paa-news-tabs' },
          [null, ...cats].map((c) => h('button', {
            className: 'paa-news-tab' + (cat === c ? ' paa-news-tab-active' : ''),
            onClick: () => { cat = c; rebuild(); if (cfg.onCat) cfg.onCat(cat, container); },
          }, c ? c.name : '全部')),
          h('span', { className: 'paa-news-count' }, '共 ' + list.length + ' 筆')),
        h('div', { className: 'paa-dlfile-list' },
          list.map((f) => fileRow(f, flash))),
        note,
        cfg.foot ? h('p', { className: 'paa-dl-note' }, cfg.foot) : null);

      const old = container.querySelector('.paa-dl-body');
      if (old) container.replaceChild(body, old);
      else container.appendChild(body);
    }

    container.appendChild(Breadcrumb([{ label: '首頁', page: 'home' }, { label: cfg.crumb }]));
    container.appendChild(PageBanner(cfg.zh, cfg.en));
    rebuild();
    return container;
  }

  async function Downloads(initialCat) {
    const data = await store.downloads();
    const files = data.items.map((f) => ({
      name: f.name, cat: f.category, catId: f.category_id, access: f.access, size: fmtBytes(f.size_bytes), type: f.type,
      url: f.file_path ? '/files/' + f.file_path : null,
    }));
    return FileListPage({
      zh: '檔案下載', en: 'DOWNLOADS', crumb: '檔案下載',
      intro: '各類申請表單與文件，歡迎下載運用。',
      files, initialCat,
      onCat: (c, view) => setUrl('downloads', c ? c.id : null, view),
    });
  }

  // ── contact page ─────────────────────────────────────────────────────────
  async function Contact() {
    const res = await store.contact();
    const c = res.contact || {};
    const rows = [
      ['會　址', c.address], ['電　話', c.tel], ['傳　真', c.fax], ['信　箱', c.email],
    ];
    return h('div', { className: 'paa-page' },
      Breadcrumb([{ label: '首頁', page: 'home' }, { label: '聯絡我們' }]),
      PageBanner('聯絡我們', 'CONTACT US'),
      h('div', { className: 'paa-wrap paa-ct' },
        h('div', { className: 'paa-ct-top' },
          h('div', { className: 'paa-ct-info' },
            Heading('聯絡資訊', 'CONTACT INFO'),
            h('div', { className: 'paa-contact-rows' },
              rows.map(([k, v]) => h('div', { className: 'paa-contact-row' },
                h('span', { className: 'paa-contact-k' }, k),
                h('span', { className: 'paa-contact-v' }, v)))),
            h('div', { className: 'paa-ct-hint' }, '本會將儘速回覆您的來信，謝謝。')),
          h('div', { className: 'paa-ct-map' },
            h('div', { className: 'paa-contact-map' },
              h('iframe', { className: 'paa-contact-mapframe', title: '本會位置地圖（OpenStreetMap）', loading: 'lazy',
                src: 'https://www.openstreetmap.org/export/embed.html?bbox=119.564612%2C23.563972%2C119.571612%2C23.568972&layer=mapnik&marker=23.566472%2C119.568112' }),
              h('a', { className: 'paa-contact-maplink', target: '_blank', rel: 'noopener',
                href: 'https://www.openstreetmap.org/?mlat=23.566472&mlon=119.568112#map=18/23.566472/119.568112' }, '在 OpenStreetMap 開啟 ↗'))))));
  }

  // ── document page (privacy / terms) ───────────────────────────────────────
  async function DocPage(key) {
    const res = await store.legal(key);
    const doc = res.item;
    const fileUrl = doc.file_key ? '/files/' + doc.file_key : null;
    return h('div', { className: 'paa-page' },
      Breadcrumb([{ label: '首頁', page: 'home' }, { label: doc.title }]),
      PageBanner(doc.title, doc.title_en),
      h('div', { className: 'paa-wrap paa-doc' },
        doc.updated_date ? h('div', { className: 'paa-doc-meta' }, '最後更新：' + doc.updated_date) : null,
        h('div', { className: 'paa-article-body' }, renderBody(doc.blocks)),
        // PDF 原始檔未上傳就不出現這顆按鈕：留一個點了會 404 的連結比沒有更糟。
        fileUrl ? h('div', { className: 'paa-doc-file' },
          h('a', { className: 'paa-btn-ghost paa-charter-btn', href: fileUrl, target: '_blank', rel: 'noopener noreferrer',
            download: dlName(doc.title, fileUrl) }, '📄 下載 PDF 原始檔')) : null,
        h('div', { className: 'paa-doc-back' },
          h('button', { className: 'paa-btn-ghost', onClick: () => go('sitemap') }, '網站導覽'),
          h('button', { className: 'paa-btn-solid', onClick: () => go('home') }, '返回首頁'))));
  }

  // ── site map page ────────────────────────────────────────────────────────
  async function Sitemap() {
    // 動態：公告分類、檔案分類皆從 API 取得，避免清單過時
    const [home, downloads] = await Promise.all([store.home(), store.downloads()]);
    const newsCats = (home.categories || []).filter((c) => c.name);
    const dlCats = uniqCats(downloads.items);
    const sections = [
      { label: '首頁', page: 'home' },
      { label: '最新公告', page: 'news', children: newsCats.map((n) => ({ label: n.name, page: 'news', arg: n.id })) },
      { label: '檔案下載', page: 'downloads', children: dlCats.map((c) => ({ label: c.name, page: 'downloads', arg: c.id })) },
      { label: '聯絡我們', page: 'contact' },
      { label: '政策與條款', children: [
        { label: '隱私權政策', page: 'privacy' }, { label: '網站使用條款', page: 'terms' },
      ] },
    ];
    return h('div', { className: 'paa-page' },
      Breadcrumb([{ label: '首頁', page: 'home' }, { label: '網站導覽' }]),
      PageBanner('網站導覽', 'SITE MAP'),
      h('div', { className: 'paa-wrap paa-sitemap' },
        h('p', { className: 'paa-sm-intro' }, '本頁彙整本網站各單元連結，便於您快速前往所需頁面。'),
        h('div', { className: 'paa-sm-grid' },
          sections.map((sec) => h('div', { className: 'paa-sm-col' },
            sec.page
              ? link(sec.page, sec.arg || null, { className: 'paa-sm-top' }, sec.label)
              : h('div', { className: 'paa-sm-top paa-sm-top-plain' }, sec.label),
            sec.children && sec.children.length ? h('ul', { className: 'paa-sm-list' },
              sec.children.map((c) => h('li', null,
                link(c.page, c.arg || null, { className: 'paa-sm-link' }, c.label)))) : null)))));
  }

  // ── stub page ────────────────────────────────────────────────────────────
  function Stub(label) {
    return h('div', { className: 'paa-page' },
      Breadcrumb([
        { label: '首頁', page: 'home' },
        { label: label || '頁面' },
      ]),
      h('div', { className: 'paa-wrap paa-stub' },
        h('img', { className: 'paa-stub-mark', src: 'assets/logo.png', alt: '社團法人澎湖縣建築師公會 會徽', width: '86', height: '86', loading: 'lazy' }),
        h('h1', { className: 'paa-stub-title' }, label),
        h('p', { className: 'paa-stub-text' }, '本頁面內容建置中'),
        h('div', { className: 'paa-stub-actions' },
          h('button', { className: 'paa-btn-solid', onClick: () => go('home') }, '返回首頁'),
          h('button', { className: 'paa-btn-ghost', onClick: () => go('news') }, '前往最新公告'))));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function Loading() {
    return h('div', { className: 'paa-loading' }, h('div', { className: 'paa-spin' }), h('span', null, '載入中…'));
  }
  function ErrorBox() {
    return h('div', { className: 'paa-page' },
      h('div', { className: 'paa-wrap paa-errbox' },
        h('div', { className: 'paa-errbox-ic' }, '⚠'),
        h('h2', null, '載入失敗'),
        h('p', null, '無法取得資料，請稍後再試。'),
        h('button', { className: 'paa-btn-solid', onClick: () => render() }, '重新載入')));
  }

  // ── router (async) ───────────────────────────────────────────────────────
  let renderSeq = 0;
  async function render() {
    const my = ++renderSeq;
    clearTimers();
    clearTeardowns();
    const main = h('main', null, Loading());

    root.innerHTML = '';
    if (siteEnv !== 'prod') root.appendChild(TestBanner());
    root.appendChild(Header(route.page));
    root.appendChild(main);
    root.appendChild(Footer());

    const p = route.page;
    let view;
    try {
      if (p === 'home') view = await Home();
      else if (p === 'news') view = await NewsList(route.arg);
      else if (p === 'downloads') view = await Downloads(route.arg);
      else if (p === 'contact') view = await Contact();
      else if (p === 'sitemap') view = await Sitemap();
      else if (p === 'privacy') view = await DocPage('privacy');
      else if (p === 'terms') view = await DocPage('terms');
      else if (p === 'article') view = await Article(route.arg);
      else view = Stub(route.arg);
    } catch (e) {
      view = ErrorBox();
    }
    if (my !== renderSeq) return;
    main.innerHTML = '';
    main.appendChild(view);
    applyMeta(route, view);
    if (route.page !== 'article') window.scrollTo(0, 0);
  }

  window.addEventListener('popstate', applyRoute);
  // 攔截站內 <a> 連結，改走前端路由（保留 Cmd/Ctrl/中鍵開新分頁的原生行為）
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[data-link]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('/')) return;
    e.preventDefault();
    if (href === location.pathname + location.search) { applyRoute(); return; }
    history.pushState({}, '', href);
    applyRoute();
  });
  // 舊 #/ 連結相容：載入時若帶 hash，轉成等義的新路徑
  if (location.hash.startsWith('#/')) {
    history.replaceState({}, '', routeToPath(legacyHashToRoute(location.hash)));
  }
  applyRoute();
  // siteEnv 預設 prod，所以正式站完全不受這次 fetch 影響（值本來就對，不會觸發下面的重繪）。
  // 只有非 prod 才會在拿到真正的 env 後重繪一次——省得為了「測試」這個標籤讓正式站
  // 多等一趟才能畫面，寧可 dev 環境晚一拍才補正確。
  apiCached('/api/config').then((cfg) => {
    if (cfg && cfg.env && cfg.env !== siteEnv) { siteEnv = cfg.env; applyRoute(); }
  }).catch(() => {});
})();
