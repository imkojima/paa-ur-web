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
    page: (slug) => apiCached('/api/pages/' + slug),
    faqs: () => apiCached('/api/faqs'),
    config: () => apiCached('/api/config'),
  };

  // Per-route teardown registry (carousel interval).
  let timers = [];
  function clearTimers() { timers.forEach(clearInterval); timers = []; }
  let teardowns = [];
  function clearTeardowns() { teardowns.forEach((fn) => fn()); teardowns = []; }

  const root = document.getElementById('root');
  let route = { page: 'home', arg: null };

  // 主選單
  // 依民眾申請步驟排列（縣府退件修正版規劃）；有 children 的是下拉選單，父項點了進第一個子頁。
  const NAV = [
    { id: 'home', label: '首頁' },
    { id: 'plan', label: '計畫介紹', children: [
      { id: 'plan', label: '計畫說明' },
      { id: 'subsidy', label: '補助辦法' },
      { id: 'process', label: '申請流程' },
    ] },
    { id: 'news', label: '最新公告' },
    { id: 'downloads', label: '資料下載' },
    { id: 'faq', label: '常見問答' },
    { id: 'consult', label: '線上諮詢' },
    { id: 'contact', label: '聯絡我們' },
  ];
  // 頁面管理（後台「頁面」模組）維護內容的前台頁：路由 id 即 pages.slug
  const INFO_PAGES = ['plan', 'subsidy', 'process'];

  // ── 站名與每頁標題／描述 ─────────────────────────────────────────────────
  // 站名；改名時 web/index.html 與 api/src/meta.ts 要一起改。
  const SITE_NAME = '澎湖縣老宅延壽機能復新計畫';
  const DEFAULT_DESC = SITE_NAME + ' — 補助辦法、申請流程、常見問答、線上諮詢與申請表單下載。';
  const PAGE_TITLES = {
    home: '', news: '最新公告', downloads: '資料下載', contact: '聯絡我們',
    plan: '計畫說明', subsidy: '補助辦法', process: '申請流程', faq: '常見問答', consult: '線上諮詢',
    privacy: '隱私權政策', terms: '網站使用條款', sitemap: '網站地圖', article: '最新公告',
  };
  function applyMeta(r, view) {
    let t = PAGE_TITLES[r.page] || '';
    // 詳細頁：直接從已渲染的 DOM 取標題（公告），無需改各頁函式
    if (view && view.querySelector) {
      const art = view.querySelector('.ur-article-title');
      if (art && art.textContent.trim()) t = art.textContent.trim();
      else if ((r.page === 'news' || r.page === 'downloads') && r.arg) {
        // 分類頁：網址帶的是分類 id，名稱從已渲染的分類鈕取
        const tab = view.querySelector('.ur-chip.is-active');
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

  // ── chrome: header / footer ──────────────────────────────────────────────
  function TestBanner() {
    return h('div', { className: 'ur-testbanner' }, '測試站：資料僅供測試，非正式網站');
  }

  // 手機版選單只是把同一份 nav 展開（.is-open）；點任何連結都會重繪整頁，選單自然收合。
  function Header(page) {
    const activeId = page === 'article' ? 'news' : page;
    const toggle = h('button', { className: 'ur-menu-btn', type: 'button', 'aria-label': '選單', 'aria-expanded': 'false',
      onClick: () => { toggle.setAttribute('aria-expanded', String(header.classList.toggle('is-open'))); } },
      h('span'), h('span'), h('span'));
    const header = h('header', { className: 'ur-header' },
      h('div', { className: 'ur-wrap ur-header-inner' },
        link('home', null, { className: 'ur-brand' }, SITE_NAME + testTag()),
        toggle,
        h('nav', { className: 'ur-nav', 'aria-label': '主選單' },
          NAV.map((n) => {
            if (!n.children) {
              return link(n.id, null, {
                className: 'ur-nav-item' + (activeId === n.id ? ' is-active' : ''),
                'aria-current': activeId === n.id ? 'page' : null,
              }, n.label);
            }
            // 下拉選單：桌機滑過／鍵盤 focus 展開（CSS :hover / :focus-within），手機選單直接攤開子項
            const inGroup = n.children.some((ch) => ch.id === activeId);
            return h('div', { className: 'ur-nav-group' + (inGroup ? ' is-active' : '') },
              link(n.id, null, { className: 'ur-nav-item ur-nav-parent' + (inGroup ? ' is-active' : ''), 'aria-haspopup': 'true' }, n.label),
              h('div', { className: 'ur-subnav' },
                n.children.map((ch) => link(ch.id, null, {
                  className: 'ur-subnav-item' + (activeId === ch.id ? ' is-active' : ''),
                  'aria-current': activeId === ch.id ? 'page' : null,
                }, ch.label))));
          }))));
    return header;
  }

  // 聯絡資訊來自後台「設定」；資料晚到再補上，不擋頁面渲染。
  function Footer() {
    const info = h('div', { className: 'ur-footer-info' });
    store.contact().then((res) => {
      const c = (res && res.contact) || {};
      [['地址', c.address], ['電話', c.tel], ['傳真', c.fax], ['信箱', c.email]]
        .filter(([, v]) => v)
        .forEach(([k, v]) => info.appendChild(h('span', null, k + '：' + v)));
    }).catch(() => {});
    return h('footer', { className: 'ur-footer' },
      h('div', { className: 'ur-wrap ur-footer-inner' },
        h('div', null,
          h('div', { className: 'ur-footer-name' }, SITE_NAME),
          info),
        h('nav', { className: 'ur-footer-links', 'aria-label': '頁尾連結' },
          link('consult', null, null, '線上諮詢'),
          link('privacy', null, null, '隱私權政策'),
          link('terms', null, null, '網站使用條款'),
          link('sitemap', null, null, '網站導覽'))),
      h('div', { className: 'ur-wrap' }, h('div', { className: 'ur-footer-copy' }, '© ' + new Date().getFullYear() + ' ' + SITE_NAME)));
  }

  function Breadcrumb(trail) {
    return h('nav', { className: 'ur-crumb', 'aria-label': '導覽路徑' },
      trail.flatMap((t, i) => [
        i > 0 ? h('span', { className: 'ur-crumb-sep', 'aria-hidden': 'true' }, '/') : null,
        t.page ? link(t.page, t.arg || null, null, t.label) : h('span', { 'aria-current': 'page' }, t.label),
      ]));
  }

  function PageHead(title, trail) {
    return h('div', { className: 'ur-pagehead' },
      h('div', { className: 'ur-wrap' },
        Breadcrumb([{ label: '首頁', page: 'home' }, ...(trail || [{ label: title }])]),
        h('h1', { className: 'ur-pagehead-title' }, title)));
  }

  function SectionHead(title, more) {
    return h('div', { className: 'ur-sechead' },
      h('h2', null, title),
      more ? link(more.page, more.arg || null, { className: 'ur-more' }, more.label + ' →') : null);
  }

  // 分類篩選鈕（公告／檔案共用）；c=null 代表「全部」
  function Chips(list, current, onPick) {
    return h('div', { className: 'ur-chips', role: 'group', 'aria-label': '分類' },
      [null, ...list].map((c) => h('button', {
        type: 'button',
        className: 'ur-chip' + (current === c ? ' is-active' : ''),
        'aria-pressed': String(current === c),
        onClick: () => onPick(c),
      }, c ? c.name : '全部')));
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

  function newsRow(item) {
    return link('article', item.id, { className: 'ur-news-row' },
      h('time', { className: 'ur-news-date', datetime: String(item.publish_date || '').slice(0, 10) }, isoToRoc(item.publish_date)),
      h('span', { className: 'ur-tag' }, h('i', { style: { background: item.color } }), item.category),
      h('span', { className: 'ur-news-title' },
        item.is_pinned ? h('span', { className: 'ur-pin' }, '置頂') : null,
        item.title));
  }

  // 舊版區塊 JSON 內文（陣列）；新內容是 TinyMCE 產生的 HTML 字串
  function renderBlocks(body) {
    return body.map((blk) => {
      if (blk.h) return h('h3', null, blk.h);
      if (blk.p) return h('p', null, blk.p);
      if (blk.list) return h('ul', null, blk.list.map((li) => h('li', null, li)));
      if (blk.table) return h('table', null,
        h('tbody', null, blk.table.map((row) => h('tr', null, h('th', null, row[0]), h('td', null, row[1])))));
      return null;
    });
  }

  function sanitizeHtml(html) {
    const t = document.createElement('div');
    t.innerHTML = String(html == null ? '' : html);
    t.querySelectorAll('script,style,iframe,object,embed,form').forEach((n) => n.remove());
    t.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
      });
    });
    t.querySelectorAll('img').forEach((im) => { im.setAttribute('loading', 'lazy'); im.setAttribute('decoding', 'async'); });
    return t.innerHTML;
  }
  function renderBody(body) {
    if (typeof body === 'string') return h('div', { className: 'ur-prose', html: sanitizeHtml(body) });
    return h('div', { className: 'ur-prose' }, renderBlocks(body || []));
  }

  // 下載時要顯示的檔名：後台設定的「檔名」通常不含副檔名，直接拿來當下載檔名，
  // Windows 會因為沒有副檔名而不知道用什麼開啟。這裡從實體檔網址補回來。
  function dlName(name, url) {
    if (!name) return '';
    const m = String(url || '').match(/\.([a-z0-9]{1,8})(?:$|[?#])/i);
    if (!m) return name;
    return new RegExp('\\.' + m[1] + '$', 'i').test(name) ? name : name + '.' + m[1];
  }

  // 檔案列（公告附件、檔案下載共用）。f: {name, size, type, date?, url?, locked?}
  // 沒有實體檔或限定存取的檔案照列出來，點了只顯示說明（onMissing）。
  function fileRow(f, onMissing) {
    const kids = [
      h('span', { className: 'ur-file-type' }, (f.type || 'pdf').toUpperCase()),
      h('span', { className: 'ur-file-name' }, f.name),
      h('span', { className: 'ur-file-meta' }, [f.date ? '更新 ' + f.date : null, f.size].filter(Boolean).join('・')),
      h('span', { className: 'ur-file-act' }, f.locked ? '未開放' : f.url ? '下載' : '未上傳'),
    ];
    if (f.url && !f.locked) {
      return h('a', { className: 'ur-file', href: f.url, target: '_blank', rel: 'noopener noreferrer', download: dlName(f.name, f.url) }, kids);
    }
    return h('button', { type: 'button', className: 'ur-file is-off',
      onClick: () => onMissing(f.locked ? '「' + f.name + '」目前未開放下載。' : '「' + f.name + '」尚未上傳檔案。') }, kids);
  }
  function fileList(files) {
    const note = h('p', { className: 'ur-note', role: 'status' });
    note.hidden = true;
    const show = (msg) => { note.textContent = msg; note.hidden = false; };
    return h('div', null, h('div', { className: 'ur-files' }, files.map((f) => fileRow(f, show))), note);
  }

  // ── hero ─────────────────────────────────────────────────────────────────
  // 多張才輪播（6 秒、滑鼠移入暫停）；只有一張就是靜態主視覺。
  // 有圖的投影片＝整張圖片橫幅：業主給的通常是文字、logo 都排好的海報，不能裁切也不能再疊字。
  // 這時標題當替代文字，第一顆按鈕當圖片連結；眉標、說明不顯示。沒有圖才用文字版主視覺。
  const plainText = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.trim(); };
  function Hero(slides) {
    if (!slides.length) return null;
    let active = 0, paused = false;
    const inner = h('div', { className: 'ur-wrap ur-hero-inner' });
    const dots = slides.length > 1
      ? slides.map((s, i) => h('button', { type: 'button', 'aria-label': '第 ' + (i + 1) + ' 張', onClick: () => show(i) }))
      : [];
    const section = h('section', { className: 'ur-hero' }, inner,
      dots.length ? h('div', { className: 'ur-wrap ur-hero-dots' }, dots) : null);

    function show(i) {
      active = (i + slides.length) % slides.length;
      const s = slides[active];
      section.classList.toggle('ur-hero-pic', !!s.bg);
      section.style.setProperty('--hero-bg', s.bg ? 'url("' + s.bg + '")' : 'none');
      inner.innerHTML = '';
      dots.forEach((d, j) => d.classList.toggle('is-active', j === active));
      if (s.bg) {
        const img = h('img', { className: 'ur-hero-img', src: s.bg, alt: plainText(s.title), decoding: 'async', fetchpriority: 'high' });
        const bn = (s.buttons || [])[0];
        inner.appendChild(!bn ? img
          : bn.url ? h('a', { href: bn.url, target: '_blank', rel: 'noopener noreferrer' }, img)
          : link(bn.page, bn.arg || null, null, img));
        return;
      }
      if (s.eyebrow) inner.appendChild(h('div', { className: 'ur-hero-eyebrow' }, s.eyebrow));
      inner.appendChild(h('h1', { className: 'ur-hero-title', html: s.title }));
      if (s.desc) inner.appendChild(h('p', { className: 'ur-hero-desc', html: s.desc }));
      if (s.buttons && s.buttons.length) {
        inner.appendChild(h('div', { className: 'ur-hero-actions' },
          s.buttons.map((bn) => {
            const cls = bn.primary ? 'ur-btn ur-btn-primary' : 'ur-btn ur-btn-ghost';
            return bn.url
              ? h('a', { className: cls, href: bn.url, target: '_blank', rel: 'noopener noreferrer' }, bn.label)
              : link(bn.page, bn.arg || null, { className: cls }, bn.label);
          })));
      }
    }
    if (dots.length) {
      section.addEventListener('mouseenter', () => { paused = true; });
      section.addEventListener('mouseleave', () => { paused = false; });
      timers.push(setInterval(() => { if (!paused) show(active + 1); }, 6000));
    }
    show(0);
    return section;
  }

  const heroShape = (s) => ({
    bg: s.background_image, eyebrow: s.eyebrow, title: s.title, desc: s.description,
    buttons: (s.buttons || []).map((b) => ({ label: b.label, page: b.target_page, arg: b.target_arg, url: b.url, primary: b.is_primary })),
  });

  // ── home page ────────────────────────────────────────────────────────────
  // 首頁快速入口：民眾最常找的五件事（縣府函文要求的項目）
  // 圖示取自 Lucide（ISC 授權）：coins、list-checks、file-down、circle-help、messages-square。
  const QUICK_ICONS = {
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    steps: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    download: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    chat: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  };
  const QUICK = [
    { page: 'subsidy', icon: 'coins', tone: 'orange', label: '補助辦法', desc: '資格、項目與額度' },
    { page: 'process', icon: 'steps', tone: 'blue', label: '申請流程', desc: '五個步驟看懂' },
    { page: 'downloads', icon: 'download', tone: 'green', label: '申請表單下載', desc: '表單、簡報、摺頁' },
    { page: 'faq', icon: 'help', tone: 'purple', label: '常見問答', desc: '先查常見問題' },
    { page: 'consult', icon: 'chat', tone: 'teal', label: '線上諮詢', desc: '值班人員線上回覆' },
  ];
  // 樣式：line＝線條＋淡色圓底｜solid＝實心圓底白圖示｜stack＝圖示在上、置中大按鈕｜color＝依入口分色
  const QUICK_STYLE = 'line';
  const quickSvg = (k) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + QUICK_ICONS[k] + '</svg>';
  function QuickLinks() {
    return h('nav', { className: 'ur-wrap ur-quick ur-quick--' + QUICK_STYLE, 'aria-label': '快速入口' },
      QUICK.map((q) => link(q.page, null, { className: 'ur-quick-item', 'data-tone': q.tone },
        h('span', { className: 'ur-quick-icon', html: quickSvg(q.icon) }),
        h('span', { className: 'ur-quick-text' }, h('strong', null, q.label), h('small', null, q.desc)))));
  }

  async function Home() {
    const [home, latest, downloads, friends] = await Promise.all([
      store.home(), store.news({ page: 1, perPage: 6 }), store.downloads(), store.friends(),
    ]);
    const dlCats = uniqCats(downloads.items);
    const links = friends.items.filter((f) => f.url);

    return h('div', null,
      Hero(home.hero.map(heroShape)),
      QuickLinks(),
      h('div', { className: 'ur-wrap ur-home' },
        h('div', { className: 'ur-home-main' },
          h('section', { className: 'ur-home-news' },
            SectionHead('最新公告', { page: 'news', label: '所有公告' }),
            latest.items.length
              ? h('div', { className: 'ur-news-list' }, latest.items.map(newsRow))
              : h('p', { className: 'ur-empty' }, '目前沒有公告。')),
          // 計畫說明（後台「計畫說明」模組維護；沒設定就不顯示）
          home.intro ? h('section', { className: 'ur-home-intro' },
            SectionHead(home.intro.title || '計畫說明'),
            h('div', { className: 'ur-prose ur-intro-body', html: sanitizeHtml(home.intro.html) })) : null),
        h('aside', { className: 'ur-home-side' },
          dlCats.length ? h('section', null,
            SectionHead('資料下載', { page: 'downloads', label: '全部' }),
            h('ul', { className: 'ur-linklist' },
              dlCats.map((ct) => h('li', null,
                link('downloads', ct.id, null,
                  h('span', null, ct.name),
                  h('span', { className: 'ur-count' }, downloads.items.filter((f) => f.category_id === ct.id).length)))))) : null,
          links.length ? h('section', null,
            SectionHead('相關連結'),
            h('ul', { className: 'ur-linklist' },
              links.map((f) => h('li', null,
                h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' },
                  h('span', null, f.name), h('span', { className: 'ur-ext', 'aria-hidden': 'true' }, '↗')))))) : null)));
  }

  // ── news list page ───────────────────────────────────────────────────────
  async function NewsList(initialCat) {
    const catsData = await store.categories();
    // cat：目前分類物件 {id,name,color}；null＝全部
    let cat = findCat(catsData, initialCat), query = '', page = 1;
    const perPage = 10;

    const container = h('div', null, PageHead('最新公告'));
    const host = h('div', { className: 'ur-wrap ur-page' });
    container.appendChild(host);

    const input = h('input', { type: 'search', className: 'ur-search-input', placeholder: '搜尋公告標題', 'aria-label': '搜尋公告標題' });
    const searchForm = h('form', { className: 'ur-search', role: 'search',
      onSubmit: (e) => { e.preventDefault(); query = input.value.trim(); page = 1; rebuild(); } },
      input, h('button', { type: 'submit', className: 'ur-btn ur-btn-primary' }, '搜尋'));
    const results = h('div');
    host.append(h('div', { className: 'ur-toolbar' }, h('div', { className: 'ur-chips-slot' }), searchForm), results);

    async function rebuild() {
      host.querySelector('.ur-chips-slot').replaceChildren(Chips(catsData, cat, pickCat));
      const data = await store.news({ category: cat ? cat.id : '', q: query, page, perPage });
      const totalPages = Math.max(1, Math.ceil(data.total / perPage));
      results.replaceChildren(...[
        h('p', { className: 'ur-resultnote' },
          query ? ['「', h('strong', null, query), '」的搜尋結果，'] : null,
          '共 ' + data.total + ' 筆',
          query ? h('button', { type: 'button', className: 'ur-linkbtn',
            onClick: () => { query = ''; input.value = ''; page = 1; rebuild(); } }, '清除搜尋') : null),
        data.items.length
          ? h('div', { className: 'ur-news-list' }, data.items.map(newsRow))
          : h('p', { className: 'ur-empty' }, '查無符合條件的公告。'),
        totalPages > 1 ? h('nav', { className: 'ur-pager', 'aria-label': '分頁' },
          h('button', { type: 'button', disabled: page === 1, onClick: () => { page -= 1; rebuild(); } }, '上一頁'),
          Array.from({ length: totalPages }, (_, i) => h('button', {
            type: 'button', className: page === i + 1 ? 'is-active' : null,
            'aria-current': page === i + 1 ? 'page' : null,
            onClick: () => { page = i + 1; rebuild(); },
          }, i + 1)),
          h('button', { type: 'button', disabled: page === totalPages, onClick: () => { page += 1; rebuild(); } }, '下一頁')) : null,
      ].filter(Boolean));
    }
    async function pickCat(c) { cat = c; page = 1; await rebuild(); setUrl('news', cat ? cat.id : null, container); }

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
    // 沒填內文時，摘要若有就當內文用
    const body = (item.body && item.body.length) ? item.body : (item.excerpt ? [{ p: item.excerpt }] : []);
    const files = (item.files || []).map((f) => ({
      name: f.name, size: fmtBytes(f.size_bytes), type: f.type, date: isoToRoc(f.file_date),
      url: f.file_path ? '/files/' + f.file_path : null,
      locked: f.access === 'member',
    }));
    const d = isoToRoc(item.publish_date).split('.');
    const navLink = (n, dir) => n
      ? link('article', n.id, { className: 'ur-artnav-item' }, h('span', null, dir), h('strong', null, n.title))
      : h('span', { className: 'ur-artnav-item is-off' }, h('span', null, dir), h('strong', null, '沒有了'));

    return h('div', null,
      h('div', { className: 'ur-pagehead' },
        h('div', { className: 'ur-wrap ur-narrow' },
          Breadcrumb([{ label: '首頁', page: 'home' }, { label: '最新公告', page: 'news' }, { label: item.category }]),
          h('h1', { className: 'ur-pagehead-title ur-article-title' }, item.title),
          h('div', { className: 'ur-article-meta' },
            h('span', { className: 'ur-tag' }, h('i', { style: { background: item.color } }), item.category),
            h('time', { datetime: String(item.publish_date || '').slice(0, 10) }, '民國 ' + d[0] + ' 年 ' + d[1] + ' 月 ' + d[2] + ' 日')))),
      h('article', { className: 'ur-wrap ur-narrow ur-page' },
        renderBody(body),
        files.length ? h('section', { className: 'ur-attach' }, h('h2', null, '附件'), fileList(files)) : null,
        h('nav', { className: 'ur-artnav', 'aria-label': '上下則' }, navLink(prev, '上一則'), navLink(next, '下一則')),
        link('news', null, { className: 'ur-back' }, '← 返回公告列表')));
  }

  // ── downloads page ───────────────────────────────────────────────────────
  async function Downloads(initialCat) {
    const data = await store.downloads();
    const files = data.items.map((f) => ({
      name: f.name, catId: f.category_id, size: fmtBytes(f.size_bytes), type: f.type,
      url: f.file_path ? '/files/' + f.file_path : null,
      locked: f.access === 'member',
    }));
    const cats = uniqCats(data.items);
    let cat = findCat(cats, initialCat);
    const container = h('div', null, PageHead('資料下載'));
    // 圖片檔（摺頁、海報）在網頁上直接看圖，點圖開原尺寸；下方檔案列表仍可下載
    const gallery = (list) => {
      const imgs = list.filter((f) => f.type === 'img' && f.url && !f.locked);
      if (!imgs.length) return null;
      return h('div', { className: 'ur-gallery' }, imgs.map((f) => h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer', className: 'ur-gallery-item' },
        h('img', { src: f.url, alt: f.name, loading: 'lazy', decoding: 'async' }),
        h('span', null, f.name))));
    };
    const host = h('div', { className: 'ur-wrap ur-page' });
    container.appendChild(host);

    function rebuild() {
      const list = cat ? files.filter((f) => f.catId === cat.id) : files;
      host.replaceChildren(...[
        cats.length > 1 ? h('div', { className: 'ur-toolbar' }, Chips(cats, cat, (c) => { cat = c; rebuild(); setUrl('downloads', cat ? cat.id : null, container); })) : null,
        h('p', { className: 'ur-resultnote' }, '共 ' + list.length + ' 筆'),
        gallery(list),
        list.length ? fileList(list) : h('p', { className: 'ur-empty' }, '目前沒有檔案。'),
      ].filter(Boolean));
    }
    rebuild();
    return container;
  }

  // ── contact page ─────────────────────────────────────────────────────────
  // 聯絡窗口（執行／主辦／指導單位）由後台「頁面」的「聯絡窗口」維護；未發布時退回設定裡的聯絡資訊。
  async function Contact() {
    const [res, units, friends] = await Promise.all([
      store.contact(), store.page('contact').catch(() => null), store.friends().catch(() => ({ items: [] })),
    ]);
    const c = res.contact || {};
    const k = res.consult || {};
    const rows = [['地址', c.address], ['電話', c.tel], ['傳真', c.fax], ['電子郵件', c.email]].filter(([, v]) => v);
    const hours = [['服務時間', c.hours], ['線上諮詢值班時段', k.hours]].filter(([, v]) => v);
    const links = (friends.items || []).filter((f) => f.url);
    return h('div', null,
      PageHead('聯絡我們'),
      h('div', { className: 'ur-wrap ur-narrow ur-page' },
        h('section', { className: 'ur-block' },
          h('h2', null, '聯絡窗口'),
          units && units.item
            ? renderBody(units.item.body)
            : rows.length
              ? h('dl', { className: 'ur-dl' }, rows.flatMap(([kk, v]) => [
                  h('dt', null, kk),
                  h('dd', null, kk === '電子郵件' ? h('a', { href: 'mailto:' + v }, v) : v),
                ]))
              : h('p', { className: 'ur-empty' }, '聯絡資訊尚未設定。')),
        hours.length ? h('section', { className: 'ur-block' },
          h('h2', null, '服務時間'),
          h('dl', { className: 'ur-dl' }, hours.flatMap(([kk, v]) => [h('dt', null, kk), h('dd', null, v)]))) : null,
        h('div', { className: 'ur-callout' },
          h('p', null, '對補助有疑問嗎？可以先查閱常見問答，或透過線上諮詢提問，值班人員會盡快回覆。'),
          h('div', { className: 'ur-callout-actions' },
            link('faq', null, { className: 'ur-btn ur-btn-ghost' }, '常見問答'),
            link('consult', null, { className: 'ur-btn ur-btn-primary' }, '線上諮詢'))),
        links.length ? h('section', { className: 'ur-block' },
          h('h2', null, '相關連結'),
          h('ul', { className: 'ur-linklist' }, links.map((f) => h('li', null,
            h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' },
              h('span', null, f.name), h('span', { className: 'ur-ext', 'aria-hidden': 'true' }, '↗')))))) : null));
  }

  // ── 計畫介紹（計畫說明／補助辦法／申請流程）───────────────────────────────
  async function InfoPage(slug) {
    const page = (await store.page(slug)).item;
    const tabs = NAV.find((n) => n.id === 'plan').children;
    return h('div', null,
      PageHead(page.title, [{ label: '計畫介紹', page: 'plan' }, { label: page.title }]),
      h('div', { className: 'ur-wrap ur-narrow ur-page' },
        h('nav', { className: 'ur-chips ur-tabs', 'aria-label': '計畫介紹' },
          tabs.map((t) => link(t.id, null, { className: 'ur-chip' + (t.id === slug ? ' is-active' : ''), 'aria-current': t.id === slug ? 'page' : null }, t.label))),
        renderBody(page.body),
        h('div', { className: 'ur-callout' },
          h('p', null, '還有疑問？先看常見問答，或透過線上諮詢提問。'),
          h('div', { className: 'ur-callout-actions' },
            link('faq', null, { className: 'ur-btn ur-btn-ghost' }, '常見問答'),
            link('consult', null, { className: 'ur-btn ur-btn-primary' }, '線上諮詢')))));
  }

  // ── 常見問答 ─────────────────────────────────────────────────────────────
  // 分類鈕＋關鍵字搜尋（問題與答案全文），點問題展開答案（<details>，鍵盤與報讀器原生支援）。
  async function Faq() {
    const data = await store.faqs();
    const cats = data.categories || [];
    const items = (data.items || []).map((f) => ({ ...f, text: (f.question + ' ' + plainText(f.answer)).toLowerCase() }));
    let cat = null, query = '';
    const container = h('div', null, PageHead('常見問答'));
    const host = h('div', { className: 'ur-wrap ur-narrow ur-page' });
    container.appendChild(host);
    const input = h('input', { type: 'search', className: 'ur-search-input', placeholder: '輸入關鍵字，例如：電梯、透天、加碼', 'aria-label': '搜尋常見問答' });
    input.addEventListener('input', () => { query = input.value.trim().toLowerCase(); rebuild(); });
    const chipsSlot = h('div');
    const results = h('div');
    host.append(h('div', { className: 'ur-toolbar' }, chipsSlot,
      h('form', { className: 'ur-search', role: 'search', onSubmit: (e) => { e.preventDefault(); } }, input)), results,
      h('div', { className: 'ur-callout' },
        h('p', null, '找不到您要的答案？歡迎透過線上諮詢提問。'),
        h('div', { className: 'ur-callout-actions' }, link('consult', null, { className: 'ur-btn ur-btn-primary' }, '線上諮詢'))));
    function rebuild() {
      chipsSlot.replaceChildren(Chips(cats, cat, (c) => { cat = c; rebuild(); }));
      const list = items.filter((f) => (!cat || f.category_id === cat.id) && (!query || f.text.includes(query)));
      const groups = (cat ? [cat] : cats).map((ct) => ({ ct, qs: list.filter((f) => f.category_id === ct.id) })).filter((g) => g.qs.length);
      results.replaceChildren(...[
        query ? h('p', { className: 'ur-resultnote' }, '「', h('strong', null, input.value.trim()), '」共 ' + list.length + ' 則') : null,
        groups.length ? groups.map((g) => h('section', { className: 'ur-faq-group' },
          h('h2', null, g.ct.name),
          g.qs.map((f) => h('details', { className: 'ur-faq' },
            h('summary', null, h('span', { className: 'ur-faq-q', 'aria-hidden': 'true' }, 'Q'), f.question),
            h('div', { className: 'ur-faq-a ur-prose', html: sanitizeHtml(f.answer) })))))
          : h('p', { className: 'ur-empty' }, '查無符合的問答。'),
      ].flat().filter(Boolean));
    }
    rebuild();
    return container;
  }

  // ── 線上諮詢 ─────────────────────────────────────────────────────────────
  // Turnstile 只在後端有設 secret 時啟用（/api/config 才會給 site key）
  let _tsP = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (_tsP) return _tsP;
    _tsP = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      sc.async = true;
      sc.onload = () => res(); sc.onerror = () => { _tsP = null; rej(new Error('turnstile')); };
      document.head.appendChild(sc);
    });
    return _tsP;
  }
  const TOWNSHIPS = ['馬公市', '湖西鄉', '白沙鄉', '西嶼鄉', '望安鄉', '七美鄉', '其他'];
  async function Consult() {
    const [res, faqData, cfg] = await Promise.all([store.contact(), store.faqs().catch(() => ({ categories: [] })), store.config().catch(() => ({}))]);
    const k = res.consult || {};
    const c = res.contact || {};
    const field = (label, ctrl, opts) => h('label', { className: 'ur-field' + (opts && opts.wide ? ' is-wide' : '') },
      h('span', null, label, opts && opts.req ? h('em', { 'aria-hidden': 'true' }, ' *') : null, opts && opts.hint ? h('small', null, opts.hint) : null), ctrl);
    const f = {
      name: h('input', { type: 'text', name: 'name', maxlength: '50', autocomplete: 'name', required: 'required' }),
      phone: h('input', { type: 'tel', name: 'phone', maxlength: '30', autocomplete: 'tel' }),
      email: h('input', { type: 'email', name: 'email', maxlength: '120', autocomplete: 'email' }),
      township: h('select', { name: 'township' }, h('option', { value: '' }, '請選擇'), TOWNSHIPS.map((t) => h('option', { value: t }, t))),
      building: h('select', { name: 'building_type' }, h('option', { value: '' }, '請選擇'), ['公寓', '透天', '不確定'].map((t) => h('option', { value: t }, t === '公寓' ? '公寓（4～6 層樓）' : t === '透天' ? '透天住宅' : t))),
      category: h('select', { name: 'category' }, h('option', { value: '' }, '請選擇'), (faqData.categories || []).map((ct) => h('option', { value: ct.name }, ct.name))),
      content: h('textarea', { name: 'content', rows: '6', maxlength: '2000', required: 'required', placeholder: '請描述您的問題，例如房屋屋齡、樓層數、想修繕的項目。' }),
      agree: h('input', { type: 'checkbox', name: 'agree' }),
      website: h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' }),
    };
    const tsBox = h('div', { className: 'ur-turnstile' });
    let tsId = null;
    if (cfg && cfg.turnstileSiteKey) {
      loadTurnstile().then(() => { tsId = window.turnstile.render(tsBox, { sitekey: cfg.turnstileSiteKey }); }).catch(() => {});
    }
    const msg = h('p', { className: 'ur-formmsg', role: 'status', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', className: 'ur-btn ur-btn-primary' }, '送出提問');
    const form = h('form', { className: 'ur-form', noValidate: 'novalidate', onSubmit: async (e) => {
      e.preventDefault();
      msg.className = 'ur-formmsg is-err';
      if (!f.name.value.trim()) { msg.textContent = '請填寫姓名。'; f.name.focus(); return; }
      if (!f.phone.value.trim() && !f.email.value.trim()) { msg.textContent = '請至少填寫聯絡電話或電子郵件其中一項，方便我們回覆。'; f.phone.focus(); return; }
      if (f.content.value.trim().length < 5) { msg.textContent = '請填寫提問內容。'; f.content.focus(); return; }
      if (!f.agree.checked) { msg.textContent = '請勾選同意個人資料蒐集告知事項。'; f.agree.focus(); return; }
      submit.disabled = true; msg.className = 'ur-formmsg'; msg.textContent = '送出中…';
      try {
        const r = await fetch('/api/inquiries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          name: f.name.value, phone: f.phone.value, email: f.email.value, township: f.township.value,
          building_type: f.building.value, category: f.category.value, content: f.content.value,
          agree: f.agree.checked, website: f.website.value,
          turnstileToken: tsId != null && window.turnstile ? window.turnstile.getResponse(tsId) : undefined,
        }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || '送出失敗，請稍後再試。');
        form.replaceChildren(h('div', { className: 'ur-done' },
          h('h3', null, '已收到您的提問'),
          h('p', null, '值班人員將於' + (k.reply_sla || '2 個工作天內') + '以電話或電子郵件回覆您。'),
          h('p', null, '案件編號：' + d.id)));
      } catch (ex) {
        msg.className = 'ur-formmsg is-err'; msg.textContent = ex.message;
        submit.disabled = false;
        if (tsId != null && window.turnstile) { try { window.turnstile.reset(tsId); } catch (_) { /* */ } }
      }
    } },
      h('div', { className: 'ur-formgrid' },
        field('姓名', f.name, { req: true }),
        field('聯絡電話', f.phone, { hint: '電話或 Email 至少填一項' }),
        field('電子郵件', f.email),
        field('房屋所在鄉鎮市', f.township),
        field('建物類型', f.building),
        field('問題類別', f.category),
        field('提問內容', f.content, { req: true, wide: true })),
      h('div', { className: 'ur-hp', 'aria-hidden': 'true' }, h('label', null, '請勿填寫', f.website)),
      h('div', { className: 'ur-privacy' },
        h('p', null, h('strong', null, '個人資料蒐集告知：'),
          '本表單蒐集您的姓名、聯絡方式、房屋所在鄉鎮市及提問內容，僅供本計畫線上諮詢回覆及統計使用，不作其他用途；計畫結束後依契約規定刪除。詳見',
          link('privacy', null, null, '隱私權政策'), '。'),
        h('label', { className: 'ur-check' }, f.agree, '我已閱讀並同意上述個人資料蒐集告知事項')),
      tsBox, msg, h('div', { className: 'ur-formfoot' }, submit));

    return h('div', null,
      PageHead('線上諮詢'),
      h('div', { className: 'ur-wrap ur-narrow ur-page' },
        h('p', { className: 'ur-lead' }, '本計畫設有網路值班人員，提供線上即時諮詢服務。提問前，建議先查閱',
          link('faq', null, null, '常見問答'), '，許多問題可以立即找到答案。'),
        h('div', { className: 'ur-channels' },
          h('section', { className: 'ur-channel' },
            h('h2', null, 'LINE 即時諮詢'),
            h('p', null, '適合簡短問題、需要來回確認，或想傳送房屋現況照片。'),
            k.hours ? h('p', { className: 'ur-channel-meta' }, '值班時段：' + k.hours) : null,
            k.line_id ? h('p', { className: 'ur-channel-meta' }, 'LINE ID：' + k.line_id) : null,
            k.line_url
              ? h('a', { className: 'ur-btn ur-btn-line', href: k.line_url, target: '_blank', rel: 'noopener noreferrer' }, '加入 LINE 好友')
              : h('p', { className: 'ur-note' }, 'LINE 官方帳號即將開放，開放前請來電或來信洽詢。')),
          cfg && cfg.inquiryForm
            ? h('section', { className: 'ur-channel' },
              h('h2', null, '線上提問表單'),
              h('p', null, '24 小時收件，適合需要詳細說明的問題，或不使用 LINE 的民眾。'),
              h('p', { className: 'ur-channel-meta' }, '回覆時限：' + (k.reply_sla || '2 個工作天內')),
              c.tel ? h('p', { className: 'ur-channel-meta' }, '電話洽詢：' + c.tel) : null)
            : h('section', { className: 'ur-channel' },
              h('h2', null, '電話與電子郵件'),
              h('p', null, '不使用 LINE，或需要詳細說明的問題，歡迎來電或來信。'),
              c.hours ? h('p', { className: 'ur-channel-meta' }, '服務時間：' + c.hours) : null,
              c.tel ? h('p', { className: 'ur-channel-meta' }, '電話：' + c.tel) : null,
              c.email ? h('p', { className: 'ur-channel-meta' }, 'Email：', h('a', { href: 'mailto:' + c.email }, c.email)) : null)),
        cfg && cfg.inquiryForm ? h('section', { className: 'ur-block', id: 'ask' }, h('h2', null, '我要提問'), form) : null));
  }

  // ── document page (privacy / terms) ───────────────────────────────────────
  async function DocPage(key) {
    const doc = (await store.legal(key)).item;
    return h('div', null,
      PageHead(doc.title),
      h('div', { className: 'ur-wrap ur-narrow ur-page' },
        doc.updated_date ? h('p', { className: 'ur-doc-meta' }, '最後更新：' + doc.updated_date) : null,
        renderBody(doc.blocks)));
  }

  // ── site map page ────────────────────────────────────────────────────────
  async function Sitemap() {
    // 公告分類、檔案分類皆從 API 取得，避免清單過時
    const [cats, downloads] = await Promise.all([store.categories(), store.downloads()]);
    const sections = [
      { label: '首頁', page: 'home' },
      { label: '計畫介紹', page: 'plan', children: NAV.find((n) => n.id === 'plan').children.map((c) => ({ label: c.label, page: c.id })) },
      { label: '最新公告', page: 'news', children: cats.map((n) => ({ label: n.name, page: 'news', arg: n.id })) },
      { label: '資料下載', page: 'downloads', children: uniqCats(downloads.items).map((c) => ({ label: c.name, page: 'downloads', arg: c.id })) },
      { label: '常見問答', page: 'faq' },
      { label: '線上諮詢', page: 'consult' },
      { label: '聯絡我們', page: 'contact' },
      { label: '隱私權政策', page: 'privacy' },
      { label: '網站使用條款', page: 'terms' },
    ];
    return h('div', null,
      PageHead('網站導覽'),
      h('div', { className: 'ur-wrap ur-narrow ur-page' },
        h('ul', { className: 'ur-sitemap' },
          sections.map((sec) => h('li', null,
            link(sec.page, null, null, sec.label),
            sec.children && sec.children.length ? h('ul', null,
              sec.children.map((c) => h('li', null, link(c.page, c.arg, null, c.label)))) : null)))));
  }

  // ── stub / loading / error ───────────────────────────────────────────────
  function Stub() {
    return h('div', { className: 'ur-wrap ur-narrow ur-state' },
      h('h1', null, '找不到這個頁面'),
      h('p', null, '頁面可能已移除，或仍在建置中。'),
      link('home', null, { className: 'ur-btn ur-btn-primary' }, '回到首頁'));
  }

  function Loading() {
    return h('div', { className: 'ur-state', role: 'status' }, h('div', { className: 'ur-spin' }), h('p', null, '載入中…'));
  }
  function ErrorBox() {
    return h('div', { className: 'ur-wrap ur-narrow ur-state' },
      h('h1', null, '載入失敗'),
      h('p', null, '無法取得資料，請稍後再試。'),
      h('button', { type: 'button', className: 'ur-btn ur-btn-primary', onClick: () => render() }, '重新載入'));
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
      else if (INFO_PAGES.includes(p)) view = await InfoPage(p);
      else if (p === 'faq') view = await Faq();
      else if (p === 'consult') view = await Consult();
      else if (p === 'sitemap') view = await Sitemap();
      else if (p === 'privacy') view = await DocPage('privacy');
      else if (p === 'terms') view = await DocPage('terms');
      else if (p === 'article') view = await Article(route.arg);
      else view = Stub();
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
