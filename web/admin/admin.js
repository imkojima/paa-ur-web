// 後台管理 SPA：管理者登入 + 內容 CRUD（公告／檔案／法律頁面／友站／輪播／設定）。
// 同源呼叫 /api/admin/*（cookie session）。
(() => {
  const app = document.getElementById('app');
  const BASE_TITLE = document.title; // index.html 的原始 <title>；標註測試一律以此為底重算，不疊加
  let me = null;
  let authed = false;     // 是否已登入；用來區分「初次未登入」與「session 中途逾時」
  // DEV/PROD 徽章依據；預設 prod（安全預設：抓不到時不要誤標成 DEV）。見 fetchEnv()。
  let env = 'prod';
  let reauthOpen = false; // 重新登入彈窗是否已開啟（避免重複疊加）
  let cats = null; // announcement categories cache

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'className') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'checked') { if (v) e.checked = true; }
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) { if (c == null || c === false) continue; e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); }
    return e;
  }

  // 列表「載入更多」分頁：fetchPage(offset)→{items,hasMore}；renderTable(allItems)→整張表節點
  function makePager(fetchPage, renderTable) {
    const listHost = h('div');
    const moreWrap = h('div', { style: 'margin-top:12px;text-align:center' });
    let offset = 0; let all = []; let hasMore = false; let loading = false;
    listHost.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
    async function load(reset) {
      if (loading) return; loading = true;
      if (reset) { all = []; offset = 0; }
      try { const r = await fetchPage(offset); all = all.concat(r.items || []); hasMore = !!r.hasMore; offset += (r.items || []).length; }
      finally { loading = false; }
      listHost.innerHTML = ''; listHost.appendChild(renderTable(all));
      moreWrap.innerHTML = '';
      if (hasMore) moreWrap.appendChild(h('button', { className: 'btn-ghost', onClick: () => load(false) }, '載入更多（已顯示 ' + all.length + ' 筆）'));
    }
    return { listHost, moreWrap, load };
  }

  const fmtBytes = (n) => { n = Number(n) || 0; if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'; if (n >= 1024) return Math.round(n / 1024) + ' KB'; return n + ' B'; };

  // 欄位說明：(i) 圖示，點擊以 tooltip 顯示說明文字
  function infoTip(text) {
    const bubble = h('span', { className: 'pa-tip-bubble' }, text);
    const btn = h('button', { type: 'button', className: 'pa-tip', 'aria-label': '說明' }, 'i', bubble);
    const onDoc = () => { btn.classList.remove('pa-tip-open'); document.removeEventListener('click', onDoc); };
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (btn.classList.contains('pa-tip-open')) { onDoc(); return; }
      btn.classList.add('pa-tip-open');
      setTimeout(() => document.addEventListener('click', onDoc), 0);
    });
    return btn;
  }

  // 已登入後才遇到 401 → session 中途逾時：開重新登入彈窗（不清掉目前頁面，未存內容保留）。
  // 登入請求本身的 401（帳密錯誤）由表單就地顯示，不在此攔截。
  function maybeReauth(status, path) {
    if (status === 401 && path !== '/login' && authed) showReauth();
  }

  async function api(path, opts = {}) {
    const r = await fetch('/api/admin' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      maybeReauth(r.status, path);
      throw Object.assign(new Error(data.error || ('HTTP ' + r.status)), { status: r.status, data });
    }
    return data;
  }

  const MAX_UPLOAD = 15 * 1024 * 1024; // 15MB（與後端一致）
  const ALLOWED_UPLOAD_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'odt', 'ods', 'odp', 'odg', 'odb', 'zip', 'rar', '7z', 'jpg', 'jpeg', 'png', 'gif', 'webp'];
  const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.odt,.ods,.odp,.odg,.odb,.zip,.rar,.7z,.jpg,.jpeg,.png,.gif,.webp';
  const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  const IMAGE_ACCEPT = IMAGE_EXT.map((e) => '.' + e).join(',');
  // multipart 版的 api()：CSV 匯入等要送 FormData 的端點用（不可自帶 content-type，
  // 否則瀏覽器沒機會補上 multipart 的 boundary）。
  async function apiForm(path, fd) {
    const r = await fetch('/api/admin' + path, { method: 'POST', body: fd, credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { maybeReauth(r.status, path); throw new Error(d.error || ('HTTP ' + r.status)); }
    return d;
  }

  async function apiUpload(file, prefix, scope) {
    if (file && file.size > MAX_UPLOAD) throw new Error('檔案大小超過上限 15MB（此檔 ' + (file.size / 1048576).toFixed(1) + 'MB）');
    if (file && ALLOWED_UPLOAD_EXT.indexOf((file.name || '').toLowerCase().split('.').pop()) === -1) throw new Error('不支援的檔案類型');
    const fd = new FormData(); fd.append('file', file); fd.append('prefix', prefix || 'uploads');
    if (scope) fd.append('scope', scope); // scope='member' → 存為會員專屬（不經公開 /files/ 服務）
    const r = await fetch('/api/admin/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { maybeReauth(r.status, '/upload'); throw new Error(d.error || ('HTTP ' + r.status)); }
    return d;
  }

  // ── 表格手機化：寬表（≥5 欄）自動轉卡片、可橫滑表加漸層捲動提示 ──
  function applyShadow(wrap) {
    const s = wrap.firstElementChild; if (!s) return;
    const max = s.scrollWidth - s.clientWidth;
    wrap.classList.toggle('can-left', s.scrollLeft > 1);
    wrap.classList.toggle('can-right', s.scrollLeft < max - 1);
  }
  function enhanceTables() {
    app.querySelectorAll('table.pa-table').forEach((t) => {
      if (t.dataset.enh) return;
      t.dataset.enh = '1';
      // 依表頭 <th> 為每格補 data-label；欄位 ≥5 的寬表在手機改成卡片式
      const ths = t.tHead ? Array.from(t.tHead.querySelectorAll('th')).map((x) => x.textContent.trim()) : [];
      if (ths.length >= 5) {
        t.classList.add('pa-cards');
        Array.from(t.tBodies).forEach((tb) => Array.from(tb.rows).forEach((row) => {
          if (row.cells.length === 1 && row.cells[0].hasAttribute('colspan')) return;
          Array.from(row.cells).forEach((td, i) => { if (ths[i]) td.setAttribute('data-label', ths[i]); });
        }));
      }
      // 包一層捲動容器，提供左右漸層提示（卡片表不會水平溢出，故不會觸發）
      if (!t.parentElement.classList.contains('pa-tablewrap')) {
        const wrap = document.createElement('div'); wrap.className = 'pa-tablewrap';
        t.parentNode.insertBefore(wrap, t); wrap.appendChild(t);
        t.addEventListener('scroll', () => applyShadow(wrap), { passive: true });
        requestAnimationFrame(() => applyShadow(wrap));
      }
    });
  }

  const MODULES = [['announcements', '公告'], ['attachments', '附件'], ['downloads', '檔案'], ['legal', '法律頁面'], ['friends', '相關連結'], ['hero', '輪播'], ['intro', '計畫說明'], ['settings', '設定'], ['admins', '管理員'], ['audit', '操作紀錄']];
  // 這些模組僅最高管理員可見/可進入
  const SUPER_ONLY = new Set(['admins', 'audit']);
  const visibleModules = () => MODULES.filter(([k]) => !SUPER_ONLY.has(k) || (me && me.role === 'superadmin'));

  // 輪播按鈕「參數」的可選項目，依「連結到」的頁面分組；值就是前台網址／路由用的識別：
  // 公告與檔案分類＝id（前台 ?category=<id>）。
  async function loadBtnArgOptions() {
    const [newsCats, docCats] = await Promise.all([
      api('/announcement-categories').catch(() => ({ items: [] })),
      api('/document-categories').catch(() => ({ items: [] })),
    ]);
    return {
      // 會員限定的公告分類／檔案分類在公開頁不會出現，選了也連不到，故不列
      news: { label: '公告分類', none: '（全部公告）', options: (newsCats.items || []).filter((c) => c.scope === 'public').map((c) => [String(c.id), c.name]) },
      downloads: { label: '檔案分類', none: '（全部檔案）', options: (docCats.items || []).filter((c) => c.access_scope !== 'member').map((c) => [String(c.id), c.name]) },
    };
  }

  const RES = {
    friends: { title: '相關連結', api: '/friends',
      cols: [['name', '名稱'], ['url', '網址'], ['sort_order', '排序'], ['is_active', '啟用', 'bool']],
      fields: [
        { col: 'name', label: '名稱', req: true }, { col: 'url', label: '網址（留空＝不可點）' },
        { col: 'sort_order', label: '排序', type: 'int' }, { col: 'is_active', label: '啟用', type: 'bool' },
      ] },
    hero: { title: '首頁輪播', api: '/hero',
      cols: [['background_image', '圖片', 'img'], ['title', '標題'], ['eyebrow', '眉標'], ['sort_order', '排序'], ['is_active', '啟用', 'bool']],
      fields: [
        { col: 'title', label: '標題（可含 <br>）', req: true, hint: '有上傳圖片時，標題不會顯示在畫面上，改作為圖片的替代文字（給螢幕報讀與搜尋引擎），請填圖片的主要內容。' },
        { col: 'eyebrow', label: '眉標（如 NEWS · 最新消息；有圖片時不顯示）' },
        { col: 'description', label: '說明（有圖片時不顯示）', type: 'textarea' },
        { col: 'background_image', label: '圖片', type: 'image', prefix: 'hero', emptyText: '未設定圖片（前台以文字版主視覺呈現）',
          hint: '上傳後前台會完整顯示整張圖片、不裁切也不疊文字，適合已排好文字與 logo 的海報或橫幅。建議橫式、寬 1600px 以上的 JPG／WebP，檔案 2MB 內載入較快（上限 15MB）；寬螢幕上圖片最高約 560px，兩側以模糊底色補滿。選好後按最下方「儲存」才會實際上傳並替換舊圖。' },
        { col: 'buttons', label: '按鈕', type: 'buttons', max: 3, hint: '沒有圖片時，按鈕顯示在標題下方（最多 3 顆）；有圖片時不顯示按鈕，改以第一顆按鈕的目的地作為點擊圖片的連結。「連結到」選站內頁面或「任意網站」；最新公告、檔案下載可再指定分類。' },
        { col: 'sort_order', label: '排序', type: 'int' }, { col: 'is_active', label: '啟用', type: 'bool' },
      ] },
    documents: { title: '檔案', api: '/documents', paginate: true, searchable: '搜尋檔名…', filterable: 'category_id', download: 'file_path',
      listNote: '此列表依上傳時間排序，最新的在最上面；跟前台「檔案下載」頁的排序規則（分類 → 更新日期 → 排序值）不同。',
      cols: [['name', '檔名'], ['category_id', '分類'], ['access', '權限', { public: '公開', member: '會員限定' }], ['type', '類型', { pdf: 'PDF', doc: 'Word', xls: 'Excel', img: '圖片', other: '其他' }], ['sort_order', '排序'], ['is_active', '顯示', 'bool']],
      fields: [
        { col: 'file_path', label: '檔案', type: 'file', prefix: 'documents', sizeCol: 'size_bytes', typeCol: 'type', accept: UPLOAD_ACCEPT, scopeFrom: 'access', fillCol: 'name', hint: '選好檔案後會自動帶入下方檔名（可自行修改）；實際上傳發生在按最下方「儲存」時。「會員限定」與否看下面的「權限」欄位，跟選檔案的先後順序無關。允許的檔案類型：' + ALLOWED_UPLOAD_EXT.join('、') + '（上限 15MB）。' },
        { col: 'name', label: '檔名', req: true },
        { col: 'description', label: '說明', type: 'textarea' },
        { col: 'category_id', label: '分類', type: 'ref', ref: '/document-categories', refLabel: 'name', req: true },
        { col: 'access', label: '權限', type: 'radio', options: [['public', '公開'], ['member', '會員限定']], lockedBy: { ref: 'category_id', col: 'access_scope', only: ['member'] } },
        { col: 'publish_date', label: '更新日期', type: 'date', today: true, hint: '決定前台排序（同分類內日期新的排前面，見下方「排序」欄說明）；不會顯示在前台頁面。新增時預設今天，可自行修改。' },
        { col: 'size_bytes', type: 'hidden' }, { col: 'type', type: 'hidden' },
        { col: 'is_active', label: '顯示', type: 'bool', defaultChecked: true },
        { col: 'sort_order', label: '排序', type: 'int', default: 999, hint: '前台排序規則：同分類內先比「更新日期」新到舊，日期相同才比這個數字（越小越排前面）。新增預設 999，只有兩筆更新日期相同時才會用到——要確保排到最前面，請同時把更新日期也調整到夠新。' },
      ] },
    documentCategories: { title: '檔案分類', api: '/document-categories',
      cols: [['name', '名稱'], ['access_scope', '適用', { both: '公開＋會員', public: '公開', member: '會員' }], ['sort_order', '排序']],
      fields: [
        { col: 'name', label: '名稱', req: true },
        { col: 'access_scope', label: '適用層級', type: 'select', options: [['both', '公開＋會員'], ['public', '公開'], ['member', '會員']], hint: '設「會員」時，此分類底下檔案的「權限」會強制鎖成會員限定，避免手殘外流；設「公開」或「公開＋會員」則各檔案可自行選公開或會員限定。' },
        { col: 'sort_order', label: '排序', type: 'int' },
      ] },
    announcementCategories: { title: '公告分類', api: '/announcement-categories',
      cols: [['name', '名稱'], ['scope', '適用對象', { public: '公開', member: '會員限定' }], ['sort_order', '排序']],
      fields: [
        { col: 'name', label: '名稱', req: true },
        { col: 'scope', label: '適用對象', type: 'select', options: [['public', '公開'], ['member', '會員限定']], hint: '「公開」分類用於一般公告；「會員限定」用於會員專區公告。分類建立後若已有公告使用，將無法變更此項。' },
        { col: 'color', label: '代表色', type: 'color', hint: '顯示於首頁「最新公告」分類標題的色點。' },
        { col: 'sort_order', label: '排序', type: 'int' },
      ] },
  };

  // 欄位顯示：hint='bool' → ✓/—；hint 為物件 → 當對照表（值→顯示文字）；其餘原樣。
  const fmtCell = (v, hint) => {
    if (hint === 'bool') return v ? '✓' : '—';
    if (hint === 'img') return v ? h('img', { className: 'pa-cell-thumb', src: assetUrl(v), alt: '' }) : h('span', { className: 'pa-cell-thumb pa-cell-thumb-none', title: '未設定圖片（文字版主視覺）' });
    if (hint && typeof hint === 'object') return hint[v] != null ? hint[v] : (v == null ? '' : String(v));
    return v == null ? '' : String(v);
  };
  // 後台位於 /admin/ 子路徑：把相對路徑（assets/…）正規化為根相對（/assets/…）；
  // /files/… 與 http(s) 維持不變。
  const assetUrl = (p) => (!p ? '' : /^(https?:|\/)/.test(p) ? p : '/' + p);
  // 內文：把舊的區塊 JSON 轉成 HTML 餵給 TinyMCE；字串則視為已是 HTML（原生載入）
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const blocksToHtml = (body) => {
    if (typeof body === 'string') return body;
    if (!Array.isArray(body)) return '';
    return body.map((b) => {
      if (b.h) return '<h3>' + esc(b.h) + '</h3>';
      if (b.p) return '<p>' + esc(b.p) + '</p>';
      if (b.list) return '<ul>' + b.list.map((li) => '<li>' + esc(li) + '</li>').join('') + '</ul>';
      if (b.table) return '<table style="border-collapse:collapse"><tbody>' + b.table.map((r) => '<tr><td><strong>' + esc(r[0]) + '</strong></td><td>' + esc(r[1]) + '</td></tr>').join('') + '</tbody></table>';
      return '';
    }).join('');
  };
  // TinyMCE 共用設定（自架於 /assets/tinymce，免 API key、UI 繁中）
  const TINY_BASE = '/assets/tinymce';
  // 延後載入 TinyMCE：只有開啟公告編輯器時才下載 ~1.4MB 套件
  let _tinyLoad = null;
  function loadTinyMce() {
    if (window.tinymce) return Promise.resolve();
    if (_tinyLoad) return _tinyLoad;
    _tinyLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TINY_BASE + '/tinymce.min.js';
      s.onload = () => resolve();
      s.onerror = () => { _tinyLoad = null; reject(new Error('TinyMCE 載入失敗')); };
      document.head.appendChild(s);
    });
    return _tinyLoad;
  }
  function initTinyMce(target, html) {
    if (!window.tinymce) return false;
    tinymce.init({
      target, license_key: 'gpl', base_url: TINY_BASE, suffix: '.min',
      language: 'zh_TW', language_url: TINY_BASE + '/langs/zh_TW.js',
      menubar: false, branding: false, promotion: false, min_height: 380,
      plugins: 'lists advlist autolink link image table code charmap searchreplace fullscreen preview visualblocks wordcount autoresize',
      toolbar: 'undo redo | blocks | bold italic underline | bullist numlist | blockquote link image table | removeformat | searchreplace visualblocks code preview fullscreen',
      toolbar_mode: 'wrap',
      block_formats: '內文=p; 標題=h2; 小標=h3',
      autoresize_bottom_margin: 24,
      table_default_attributes: { border: '1' },
      table_default_styles: { 'border-collapse': 'collapse', width: '100%' },
      content_style: 'body{font-family:"Noto Sans TC",system-ui,sans-serif;font-size:15px;line-height:1.8;color:#1c2733} table{border-collapse:collapse} td,th{border:1px solid #d9dee3;padding:6px 10px}',
      init_instance_callback: (ed) => { ed.setContent(html || ''); },
    });
    return true;
  }

  // ── login ────────────────────────────────────────────────
  // Turnstile（人機驗證）：未啟用（後端未設 secret）時自動略過
  let _tsP = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (_tsP) return _tsP;
    _tsP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.defer = true;
      s.onload = () => res(); s.onerror = () => { _tsP = null; rej(new Error('turnstile')); };
      document.head.appendChild(s);
    });
    return _tsP;
  }
  // DEV/PROD 徽章：以後端 /api/config 的 env 為準（見 index.ts），不猜網址。
  // start() 會先 await 這支再畫任何畫面（登入頁或後台首頁皆然）——後台不是拚首次繪製速度的
  // 公開頁面，寧可多等一趟同源小請求，換登入頁一開始就標示正確，不要有「先看到沒標註的畫面」這種閃爍。
  async function fetchEnv() {
    try { const cfg = await fetch('/api/config').then((r) => r.json()); if (cfg && cfg.env) env = cfg.env; } catch { /* 保留預設 prod */ }
    // 以 BASE_TITLE 重算而非疊加：start() 在登入成功後會再呼叫一次 fetchEnv()，
    // 疊加的話標題會愈長愈多「（測試）」。
    document.title = BASE_TITLE + (env === 'dev' ? '（測試）' : '');
  }
  // 後台各處共用的 DEV/PROD 徽章（登入頁、已登入後的頂列都用這個，樣式與判斷邏輯只寫一處）。
  const envBadge = () => h('span', { className: 'pa-env' }, env === 'dev' ? 'DEV' : 'PROD');
  // 測試站橫幅：比角落那個小徽章明顯得多，登入頁跟登入後的畫面都會在最上方加這條。
  const testBanner = () => h('div', { className: 'pa-testbanner' }, '測試站：資料僅供測試，非正式後台');
  async function mountTurnstile(container) {
    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      if (!cfg.turnstileSiteKey) return null;
      await loadTurnstile();
      const id = window.turnstile.render(container, { sitekey: cfg.turnstileSiteKey });
      return { token: () => window.turnstile.getResponse(id), reset: () => { try { window.turnstile.reset(id); } catch { /* */ } } };
    } catch { return null; }
  }

  // session 中途逾時時的「就地重新登入」彈窗：疊在目前頁面上，不清空表單，
  // 登入成功後關閉，使用者再按一次「儲存」即可送出原本未存的內容。
  function showReauth() {
    if (reauthOpen) return;
    reauthOpen = true;
    const u = h('input', { type: 'text', autocomplete: 'username' });
    const p = h('input', { type: 'password', autocomplete: 'current-password' });
    if (me && me.username) u.value = me.username;
    const err = h('div', { className: 'pa-err' }); err.style.display = 'none';
    const tsBox = h('div', { style: 'margin:10px 0' });
    let ts = null;
    const overlay = h('div', { style: 'position:fixed;inset:0;background:rgba(10,20,40,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:1000' });
    const close = () => { reauthOpen = false; overlay.remove(); };
    const submit = async (e) => {
      e.preventDefault(); err.style.display = 'none';
      const btn = e.target.querySelector('button[type=submit]'); const lbl = btn.textContent; btn.disabled = true; btn.textContent = '登入中…';
      try {
        await api('/login', { method: 'POST', body: { username: u.value, password: p.value, turnstileToken: ts ? ts.token() : undefined } });
        authed = true;
        try { me = (await api('/me')).user; } catch (e2) { /* 沿用原 me */ }
        close();
      } catch (ex) {
        err.textContent = ex.message; err.style.display = ''; btn.disabled = false; btn.textContent = lbl; if (ts) ts.reset();
      }
    };
    overlay.appendChild(h('form', { className: 'pa-login-card', style: 'position:relative;margin:0', onSubmit: submit },
      h('button', { type: 'button', 'aria-label': '關閉', style: 'position:absolute;top:8px;right:12px;border:0;background:none;font-size:22px;line-height:1;color:#999;cursor:pointer', onClick: close }, '×'),
      h('h1', null, '登入已逾時'),
      h('p', null, '閒置過久，請重新登入。您未儲存的內容仍保留在原頁面，登入後再按一次「儲存」即可。'),
      h('label', { className: 'pa-field' }, h('span', null, '帳號'), u),
      h('label', { className: 'pa-field' }, h('span', null, '密碼'), p),
      tsBox, err,
      h('button', { className: 'btn', type: 'submit', style: 'width:100%;margin-top:6px' }, '重新登入')));
    document.body.appendChild(overlay);
    setTimeout(() => p.focus(), 0);
    mountTurnstile(tsBox).then((x) => { ts = x; });
  }

  function loginView() {
    const u = h('input', { type: 'text', autocomplete: 'username' });
    const p = h('input', { type: 'password', autocomplete: 'current-password' });
    const err = h('div', { className: 'pa-err' }); err.style.display = 'none';
    const tsBox = h('div', { style: 'margin:12px 0' });
    let ts = null;
    const submit = async (e) => {
      e.preventDefault(); err.style.display = 'none';
      const btn = e.target.querySelector('button[type=submit]'); const lbl = btn.textContent; btn.disabled = true; btn.textContent = '登入中…';
      try { await api('/login', { method: 'POST', body: { username: u.value, password: p.value, turnstileToken: ts ? ts.token() : undefined } }); start(); }
      catch (ex) { err.textContent = ex.message; err.style.display = ''; btn.disabled = false; btn.textContent = lbl; if (ts) ts.reset(); }
    };
    app.innerHTML = '';
    if (env === 'dev') app.appendChild(testBanner());
    app.appendChild(h('div', { className: 'pa-login' },
      h('form', { className: 'pa-login-card', onSubmit: submit },
        h('h1', null, '後台管理 ', envBadge()),
        h('p', null, '澎湖縣老宅延壽機能復新計畫'),
        h('label', { className: 'pa-field' }, h('span', null, '帳號'), u),
        h('label', { className: 'pa-field' }, h('span', null, '密碼'), p),
        tsBox,
        err,
        h('button', { className: 'btn', type: 'submit', style: 'width:100%;margin-top:6px' }, '登入'))));
    mountTurnstile(tsBox).then((x) => { ts = x; });
  }

  // ── chrome + module nav ──────────────────────────────────
  function chrome(active, body) {
    app.innerHTML = '';
    if (env === 'dev') app.appendChild(testBanner());
    app.appendChild(h('div', { className: 'pa-top' },
      h('div', { className: 'pa-top-brand' }, h('img', { src: '../assets/favicon.svg', alt: '' }), '網站後台', envBadge()),
      h('div', { className: 'pa-top-right' },
        h('span', null, me.name + '（' + me.role + '）'),
        h('button', { className: 'btn-ghost btn-sm', onClick: () => goAdmin('change-password') }, '變更密碼'),
        h('button', { className: 'btn-ghost btn-sm', onClick: logout }, '登出'))));
    app.appendChild(h('div', { className: 'pa-nav' },
      visibleModules().map(([k, l]) => h('button', { className: 'pa-navbtn' + (active === k ? ' pa-navbtn-active' : ''), onClick: () => goAdmin(k) }, l))));
    const wrap = h('div', { className: 'pa-wrap' });
    app.appendChild(wrap);
    wrap.appendChild(body);
  }

  async function logout() { try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ } authed = false; me = null; loginView(); }

  // 管理者變更自己的密碼
  function showChangePassword() {
    const cur = h('input', { type: 'password' });
    const np = h('input', { type: 'password' });
    const cf = h('input', { type: 'password' });
    const msg = h('div', { className: 'pa-err' }); msg.style.display = 'none';
    const save = async () => {
      msg.style.display = 'none'; msg.style.color = 'var(--red)';
      if (np.value.length < 8) { msg.textContent = '新密碼至少 8 碼'; msg.style.display = ''; return; }
      if (np.value !== cf.value) { msg.textContent = '兩次新密碼不一致'; msg.style.display = ''; return; }
      try {
        await api('/change-password', { method: 'POST', body: { current_password: cur.value, new_password: np.value } });
        msg.textContent = '密碼已變更 ✓'; msg.style.color = 'var(--green)'; msg.style.display = '';
        cur.value = ''; np.value = ''; cf.value = '';
      } catch (ex) { msg.textContent = ex.message; msg.style.display = ''; }
    };
    chrome('', h('div', null,
      h('div', { className: 'pa-h' }, h('h2', null, '變更密碼'), h('button', { className: 'btn-ghost', onClick: () => goAdmin('announcements') }, '← 返回')),
      h('div', { className: 'pa-form', style: 'max-width:420px' },
        h('label', { className: 'pa-field' }, h('span', null, '目前密碼'), cur),
        h('label', { className: 'pa-field' }, h('span', null, '新密碼（至少 8 碼，需含英文字母與數字）'), np),
        h('label', { className: 'pa-field' }, h('span', null, '確認新密碼'), cf),
        msg,
        h('div', { className: 'pa-form-foot' }, h('button', { className: 'btn-accent', onClick: save }, '更新密碼')))));
  }

  function showModule(k, arg) {
    if (window.tinymce) tinymce.remove();
    if (SUPER_ONLY.has(k) && (!me || me.role !== 'superadmin')) k = 'announcements'; // 僅 superadmin
    if (k === 'announcements') chrome('announcements', announcementsResource(arg));
    else if (k === 'legal') chrome('legal', legalResource(arg));
    else if (k === 'downloads') chrome('downloads', downloadsResource(arg));
    else if (k === 'settings') chrome('settings', settingsResource());
    else if (k === 'intro') chrome('intro', introResource());
    else if (k === 'admins') chrome('admins', adminsResource());
    else if (k === 'audit') chrome('audit', auditResource(arg));
    else if (k === 'attachments') chrome('attachments', attachmentsResource());
    else chrome(k, genericResource(RES[k], k));
  }

  // 管理員管理（僅 superadmin）：列表＋新增／編輯角色／停用／重設密碼
  function adminsResource() {
    const host = h('div');
    const ROLE_LABEL = { superadmin: '最高管理員', editor: '編輯者', viewer: '唯讀' };
    // 列表→編輯／新增走 openForm()：把網址推成 #admins/<id 或 new>，讓瀏覽器上一頁能回到列表；
    // 「返回列表」／存檔成功走 backToList()。
    const openForm = (item) => { enterDetail('admins', item ? item.id : null); showForm(item); };
    const backToList = () => { if (!leaveDetail('admins')) showList(); };
    async function showList() {
      host.innerHTML = ''; host.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
      const { items } = await api('/admins');
      const rows = items.map((a) => h('tr', null,
        h('td', null, a.username),
        h('td', null, a.name),
        h('td', null, ROLE_LABEL[a.role] || a.role),
        h('td', null, a.is_active ? h('span', { className: 'pa-st-published' }, '啟用') : h('span', { className: 'pa-st-archived' }, '停用')),
        h('td', null, a.last_login_at ? String(a.last_login_at).slice(0, 16) : '—'),
        h('td', null, h('div', { className: 'pa-actions' }, h('button', { className: 'btn-ghost btn-sm', onClick: () => openForm(a) }, '編輯')))));
      host.innerHTML = '';
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, '管理員'),
          h('button', { className: 'btn-accent btn-sm', onClick: () => openForm(null) }, '＋ 新增管理員')),
        h('p', { className: 'pa-hint' }, '角色：最高管理員＝可管理員＋全部內容；編輯者＝可編輯全部內容；唯讀＝僅檢視。'),
        h('table', { className: 'pa-table' },
          h('thead', null, h('tr', null, ['帳號', '姓名', '角色', '狀態', '上次登入', '操作'].map((t) => h('th', null, t)))),
          h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: '6', style: 'text-align:center;color:#999;padding:26px' }, '尚無管理員'))))));
    }
    function showForm(item) {
      const isNew = !item;
      const f = {};
      f.username = h('input', { type: 'text', value: item ? item.username : '' });
      if (!isNew) f.username.disabled = true;
      f.name = h('input', { type: 'text', value: item ? item.name : '' });
      f.email = h('input', { type: 'text', value: item && item.email ? item.email : '' });
      f.role = h('select', null, [['superadmin', '最高管理員'], ['editor', '編輯者'], ['viewer', '唯讀']].map(([v, l]) => h('option', { value: v, ...((item ? item.role : 'editor') === v ? { selected: 'selected' } : {}) }, l)));
      f.is_active = h('input', { type: 'checkbox', checked: item ? !!item.is_active : true });
      f.password = h('input', { type: 'password', autocomplete: 'new-password' });
      const err = h('div', { className: 'pa-err' }); err.style.display = 'none';
      const fail = (m) => { err.textContent = m; err.style.color = 'var(--red)'; err.style.display = ''; };
      const ok = (m) => { err.textContent = m; err.style.color = 'var(--green)'; err.style.display = ''; };
      const save = async () => {
        err.style.display = 'none';
        try {
          if (isNew) {
            await api('/admins', { method: 'POST', body: { username: f.username.value.trim(), name: f.name.value.trim(), email: f.email.value.trim() || null, role: f.role.value, password: f.password.value } });
          } else {
            await api('/admins/' + item.id, { method: 'PUT', body: { name: f.name.value.trim(), email: f.email.value.trim() || null, role: f.role.value, is_active: f.is_active.checked } });
          }
          backToList();
        } catch (ex) { fail(ex.message); }
      };
      const changePw = async () => {
        if ((f.password.value || '').length < 8) { fail('新密碼至少 8 碼'); return; }
        try { await api('/admins/' + item.id + '/password', { method: 'POST', body: { password: f.password.value } }); f.password.value = ''; ok('密碼已變更 ✓'); }
        catch (ex) { fail(ex.message); }
      };
      host.innerHTML = '';
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, isNew ? '新增管理員' : '編輯管理員'),
          h('button', { className: 'btn-ghost', onClick: backToList }, '← 返回列表')),
        h('div', { className: 'pa-form' },
          h('div', { className: 'pa-form-row' },
            h('label', { className: 'pa-field' }, h('span', null, '帳號 ＊'), f.username),
            h('label', { className: 'pa-field' }, h('span', null, '姓名 ＊'), f.name)),
          h('div', { className: 'pa-form-row' },
            h('label', { className: 'pa-field' }, h('span', null, 'Email'), f.email),
            h('label', { className: 'pa-field' }, h('span', null, '角色'), f.role)),
          isNew
            ? h('label', { className: 'pa-field' }, h('span', null, '密碼 ＊（至少 8 碼，需含英文字母與數字）'), f.password)
            : h('div', null,
                h('label', { className: 'pa-check' }, f.is_active, '帳號啟用'),
                h('div', { className: 'pa-form-row', style: 'margin-top:10px' },
                  h('label', { className: 'pa-field' }, h('span', null, '變更密碼（至少 8 碼，需含英文字母與數字）'), f.password),
                  // margin-bottom 跟 .pa-field 對齊：pa-form-row 用 align-items:stretch 撐開兩欄，
                  // 沒有這個 margin 這欄會多撐出 .pa-field 那 14px margin 的高度，按鈕就會比密碼欄低一截。
                  h('div', { style: 'display:flex;align-items:flex-end;margin-bottom:14px' }, h('button', { className: 'btn-ghost', type: 'button', onClick: changePw }, '變更密碼'))),
                // 按鈕故意不叫「重設密碼」：避免跟會員那邊「重設＝系統隨機產生一組新密碼」搞混，
                // 這裡是管理者自己打一組密碼直接套用，語意上更接近「變更」。
                h('p', { className: 'pa-hint' }, '填入新密碼後請按「變更密碼」套用；按下方「儲存」不會套用這裡填的密碼，只會更新姓名／Email／角色等欄位。')),
          err,
          h('div', { className: 'pa-form-foot' },
            h('button', { className: 'btn-accent', onClick: save }, isNew ? '建立' : '儲存'),
            h('button', { className: 'btn-ghost', onClick: backToList }, '取消')))));
    }
    showList();
    return host;
  }

  // 操作紀錄（稽核日誌；僅 superadmin，唯讀分頁）
  function auditResource(arg) {
    const host = h('div');
    const ACT = {
      create: '新增', update: '修改', delete: '刪除',
      'reset-password': '重設密碼', 'change-password': '變更密碼',
      'login-failed': '登入失敗', 'auto-publish': '自動發布（預約）',
    };
    const ENT = {
      announcement: '公告', announcement_category: '公告分類',
      admin_user: '管理員', admin: '管理員', attachment: '附件',
      legal_page: '法律頁面', settings: '設定',
    };
    const LIMIT = 50;
    // #audit/<頁碼> 深連結：直接輸入網址也要能落在該頁。頁碼不合法（缺省／非數字）一律回第 1 頁。
    const initialPage = Math.max(1, parseInt(arg, 10) || 1);
    let items = []; let offset = (initialPage - 1) * LIMIT; let hasMore = false; let loading = false;
    let openId = null; // 目前展開詳情的那一列 id；換頁時重置（見 load()）
    // 篩選條件；q 同時比對管理員帳號/姓名、對象、IP、變更內容。
    let q = ''; let actionF = ''; let entityF = ''; let from = ''; let to = '';
    let actionOptions = []; let entityOptions = []; let filtered = false;
    const tbody = h('tbody');
    const pagerWrap = h('div', { style: 'margin-top:12px;display:flex;justify-content:center;align-items:center;gap:14px' });
    const fmtChanges = (s) => { if (!s) return null; try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s); } };
    // DB 存 UTC（見 migrations/0001_init.sql 的 audit_logs.created_at 預設值），這裡固定 +8 顯示
    // 成台灣時間（同 index.ts 的 publishDueAnnouncements：台灣全年無日光節約，+8 沒有例外）。
    const fmtTime = (s) => {
      const d = s ? new Date(String(s).replace(' ', 'T') + 'Z') : null;
      if (!d || Number.isNaN(d.getTime())) return String(s || '—').slice(0, 16);
      return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    };
    function rowEl(l) {
      // 只顯示帳號（不含姓名）省版面；姓名收進 title，滑鼠移上去還是查得到是誰。
      const who = l.admin_username || l.admin_name || '—';
      const whoTitle = l.admin_name ? l.admin_name + (l.admin_username ? '（' + l.admin_username + '）' : '') : who;
      const ent = (l.entity_type || '') + (l.entity_id ? ' #' + l.entity_id : '');
      const json = fmtChanges(l.changes);
      const isOpen = openId === l.id;
      const mainRow = h('tr', null,
        h('td', null, fmtTime(l.created_at)),
        h('td', { title: whoTitle }, who),
        h('td', null, ACT[l.action] || l.action),
        h('td', { title: ent || '—' }, ent || '—'),
        h('td', null, l.ip || '—'),
        h('td', null, json
          ? h('button', { className: 'btn-ghost btn-sm', type: 'button', onClick: () => { openId = isOpen ? null : l.id; render(); } }, isOpen ? '收合' : '詳情')
          : '—'));
      if (!isOpen || !json) return [mainRow];
      // 詳情展開成下方獨立一列（橫跨全部欄位），不會撐大「變更」那一欄或墊高本列。
      const detailRow = h('tr', null, h('td', { colspan: '6', style: 'background:var(--cream)' },
        h('pre', { style: 'white-space:pre-wrap;font-size:12px;margin:0;color:var(--body)' }, json)));
      return [mainRow, detailRow];
    }
    function render() {
      tbody.innerHTML = '';
      (items.length ? items.flatMap(rowEl) : [h('tr', null, h('td', { colspan: '6', style: 'text-align:center;color:#999;padding:26px' },
        filtered ? '查無符合的紀錄' : '尚無紀錄'))]).forEach((r) => tbody.appendChild(r));
      pagerWrap.innerHTML = '';
      pagerWrap.appendChild(h('button', { className: 'btn-ghost', type: 'button', disabled: offset === 0 || loading, onClick: () => load(Math.max(0, offset - LIMIT)) }, '← 上一頁'));
      pagerWrap.appendChild(h('span', { className: 'pa-hint' }, '第 ' + (Math.floor(offset / LIMIT) + 1) + ' 頁'));
      pagerWrap.appendChild(h('button', { className: 'btn-ghost', type: 'button', disabled: !hasMore || loading, onClick: () => load(offset + LIMIT) }, '下一頁 →'));
    }
    // 用 replaceState（不是改 location.hash）同步網址：不會多推瀏覽器歷史、也不會觸發
    // hashchange 讓整個模組重新掛載（同 enterDetail 那套做法）。頁碼為 1 時網址簡化成 #audit。
    // 篩選條件不進網址（跟會費／福利金列表一致），重新整理會回到未篩選狀態。
    function syncUrl() {
      const page = Math.floor(offset / LIMIT) + 1;
      const t = '#audit' + (page > 1 ? '/' + page : '');
      if (location.hash !== t) history.replaceState(null, '', t);
    }
    const qs = () => (q ? '&q=' + encodeURIComponent(q) : '')
      + (actionF ? '&action=' + encodeURIComponent(actionF) : '')
      + (entityF ? '&entity_type=' + encodeURIComponent(entityF) : '')
      + (isYmdLike(from) ? '&from=' + from : '') + (isYmdLike(to) ? '&to=' + to : '');
    function isYmdLike(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || ''); }
    // 下拉選單的選項由後端回傳實際出現過的值（同會費頁「會期」下拉的作法），不必手動維護清單、
    // 也不會列出從未發生過的動作／對象類型。
    function fillSelect(sel, options, labelMap, allLabel, current) {
      sel.innerHTML = '';
      [['', allLabel], ...options.map((v) => [v, labelMap[v] || v])].forEach(([v, l]) =>
        sel.appendChild(h('option', { value: v, ...(current === v ? { selected: 'selected' } : {}) }, l)));
    }
    async function load(newOffset) {
      if (loading) return; loading = true;
      offset = newOffset; openId = null;
      try {
        const r = await api('/audit-logs?limit=' + LIMIT + '&offset=' + offset + qs());
        items = r.items || []; hasMore = !!r.hasMore; filtered = !!r.filtered;
        actionOptions = r.actions || []; entityOptions = r.entityTypes || [];
        fillSelect(actionSel, actionOptions, ACT, '全部動作', actionF);
        fillSelect(entitySel, entityOptions, ENT, '全部對象', entityF);
      } finally { loading = false; }
      syncUrl();
      render();
    }
    const qInput = h('input', { type: 'text', value: q, placeholder: '對象／管理員／IP…', style: 'min-width:190px' });
    const doSearch = () => { q = qInput.value.trim(); load(0); };
    qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    const actionSel = h('select', { style: 'min-width:110px' });
    actionSel.addEventListener('change', () => { actionF = actionSel.value; load(0); });
    const entitySel = h('select', { style: 'min-width:110px' });
    entitySel.addEventListener('change', () => { entityF = entitySel.value; load(0); });
    const fromInp = h('input', { type: 'date', value: from, style: 'width:150px' });
    const toInp = h('input', { type: 'date', value: to, style: 'width:150px' });
    const applyDates = () => { from = fromInp.value; to = toInp.value; load(0); };
    fromInp.addEventListener('change', applyDates); toInp.addEventListener('change', applyDates);
    const clearBtn = h('button', { className: 'btn-ghost btn-sm', type: 'button', onClick: () => {
      q = ''; actionF = ''; entityF = ''; from = ''; to = '';
      qInput.value = ''; fromInp.value = ''; toInp.value = '';
      load(0);
    } }, '清除篩選');
    tbody.appendChild(h('tr', null, h('td', { colspan: '6', className: 'pa-loading' }, '載入中…')));
    host.appendChild(h('div', null,
      h('div', { className: 'pa-h' }, h('h2', null, '操作紀錄')),
      h('p', { className: 'pa-hint' }, '記錄每次後台寫入操作（管理員、時間、動作、對象、來源 IP）；時間為台灣時間。'),
      h('div', { className: 'pa-subnav' },
        qInput, actionSel, entitySel,
        h('span', { className: 'pa-hint' }, '從'), fromInp, h('span', { className: 'pa-hint' }, '到'), toInp,
        h('button', { className: 'btn-ghost btn-sm', type: 'button', onClick: doSearch }, '搜尋'), clearBtn),
      h('table', { className: 'pa-table pa-table-audit' },
        h('thead', null, h('tr', null, ['時間', '管理員', '動作', '對象', 'IP', '變更'].map((t) => h('th', null, t)))),
        tbody),
      pagerWrap));
    load(offset);
    return host;
  }

  // 公告附件總管（容量管理：依容量/最新排序、刪除、總用量）
  function attachmentsResource() {
    const host = h('div');
    let sort = 'size';
    let query = '';  // 檔名或所屬公告標題關鍵字
    let from = '';   // 上傳日期起（YYYY-MM-DD，空＝不限）
    let to = '';     // 上傳日期迄
    function showList() {
      host.innerHTML = '';
      const hasFilter = !!(query || from || to);
      // 依日期排序或有日期條件時，多顯示「上傳日期」欄，讓篩選結果看得出依據
      const byDate = sort === 'date' || sort === 'date_asc' || !!(from || to);
      const totalNote = h('span', { className: 'pa-hint' }, '統計中…');
      const rowEl = (a) => h('tr', null,
        h('td', null, (a.access === 'member' || a.ann_visibility === 'member') ? h('span', { title: '需登入才能下載' }, '🔒 ') : null, a.name),
        // 所屬公告可點入編輯頁；公告已刪除（ann_title 為空）的孤兒附件不給連結，避免點進 404
        h('td', null, a.ann_title
          ? h('a', { className: 'pa-link', href: '#announcements/' + a.owner_id, title: '編輯這則公告' }, a.ann_title)
          : h('span', { className: 'pa-hint' }, '公告 #' + a.owner_id + '（已刪除）')),
        h('td', null, (a.type || '').toUpperCase()),
        h('td', null, fmtBytes(a.size_bytes)),
        byDate ? h('td', null, (a.created_at || '').slice(0, 10)) : null,
        h('td', null, h('div', { className: 'pa-actions' },
          // 需登入的附件位於 member/ 前綴，公開 /files/* 取不到，改走後台認證端點
          a.file_path ? h('a', { className: 'btn-ghost btn-sm', target: '_blank', rel: 'noopener', style: 'text-decoration:none',
            href: String(a.file_path).indexOf('member/') === 0 ? '/api/admin/attachments/' + a.id + '/download' : '/files/' + a.file_path }, '下載') : null,
          h('button', { className: 'btn-danger btn-sm', onClick: async () => { if (!confirm('刪除附件「' + a.name + '」？此動作無法復原。')) return; await api('/attachments/' + a.id, { method: 'DELETE' }); pager.load(true); } }, '刪除'))));
      const headers = ['檔名', '所屬公告', '類型', '大小', byDate ? '上傳日期' : null, '操作'].filter(Boolean);
      const renderTable = (items) => h('table', { className: 'pa-table' },
        h('thead', null, h('tr', null, headers.map((t) => h('th', null, t)))),
        h('tbody', null, items.length ? items.map(rowEl) : h('tr', null, h('td', { colspan: String(headers.length), style: 'text-align:center;color:#999;padding:26px' }, hasFilter ? '查無符合的附件' : '尚無附件'))));
      const pager = makePager(async (offset) => {
        const r = await api('/attachments?sort=' + sort + '&limit=50&offset=' + offset
          + (query ? '&q=' + encodeURIComponent(query) : '')
          + (from ? '&from=' + encodeURIComponent(from) : '')
          + (to ? '&to=' + encodeURIComponent(to) : ''));
        totalNote.textContent = (r.filtered ? '符合條件 ' : '目前共 ') + (r.totalCount || 0) + ' 個附件，合計 ' + fmtBytes(r.totalBytes || 0);
        return r;
      }, renderTable);
      const search = h('input', { type: 'text', value: query, placeholder: '搜尋檔名或公告標題…', style: 'min-width:190px' });
      const fromEl = h('input', { type: 'date', value: from, title: '上傳日期起' });
      const toEl = h('input', { type: 'date', value: to, title: '上傳日期迄' });
      // 關鍵字需按 Enter 或「搜尋」；日期改動即重新查詢（與其他頁面的下拉篩選一致）
      const doSearch = () => { query = search.value.trim(); from = fromEl.value; to = toEl.value; showList(); };
      search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
      fromEl.addEventListener('change', doSearch);
      toEl.addEventListener('change', doSearch);
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, '公告附件'), totalNote),
        h('p', { className: 'pa-hint' }, '此處彙整所有公告的附件，依容量排序可快速找出大檔清理（刪除會同時移除檔案）。'),
        h('div', { className: 'pa-subnav' },
          h('button', { className: 'pa-subbtn' + (sort === 'size' ? ' pa-subbtn-active' : ''), onClick: () => { if (sort !== 'size') { sort = 'size'; showList(); } } }, '依容量'),
          h('button', { className: 'pa-subbtn' + (sort === 'date' ? ' pa-subbtn-active' : ''), onClick: () => { if (sort !== 'date') { sort = 'date'; showList(); } } }, '依最新'),
          h('button', { className: 'pa-subbtn' + (sort === 'date_asc' ? ' pa-subbtn-active' : ''), onClick: () => { if (sort !== 'date_asc') { sort = 'date_asc'; showList(); } } }, '依最舊')),
        h('div', { className: 'pa-subnav pa-filterrow' },
          search,
          h('span', { className: 'pa-hint' }, '上傳日期'), fromEl, h('span', { className: 'pa-hint' }, '～'), toEl,
          h('button', { className: 'btn-ghost btn-sm', onClick: doSearch }, '搜尋'),
          hasFilter ? h('button', { className: 'btn-ghost btn-sm', onClick: () => { query = ''; from = ''; to = ''; showList(); } }, '清除') : null),
        pager.listHost, pager.moreWrap));
      pager.load(true);
    }
    showList();
    return host;
  }

  // 批次作業的「對象會籍」勾選列（會費開徵／福利金發放共用）。
  // 會籍狀態會直接決定誰被建立紀錄，是最容易誤操作的一項，故：
  // 一、預設值依業務性質不同（會費是義務、福利金是權利）；
  // 二、把每種狀態的人數即時標在勾選框上，執行前就看得到影響範圍。
  // 首頁「計畫說明」區塊：settings 的 home_intro（{ title, html }）。內文留空＝前台不顯示該區塊。
  function introResource() {
    const host = h('div');
    (async () => {
      if (window.tinymce) tinymce.remove();
      host.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
      const { settings } = await api('/settings');
      const cur = settings.home_intro || {};
      const title = h('input', { type: 'text', value: cur.title || '', placeholder: '例：老宅延壽機能復新計畫' });
      const body = h('textarea', { id: 'intro-body', className: 'pa-richtext' });
      const msg = h('div', { className: 'pa-err' }); msg.style.display = 'none';
      const save = async () => {
        const ed = window.tinymce && tinymce.get('intro-body');
        const html = ed ? ed.getContent() : (body.value || '');
        try {
          await api('/settings/home_intro', { method: 'PUT', body: { value: {
            title: title.value.trim(),
            html: (html && html !== '<p><br></p>') ? html : '',
          } } });
          msg.textContent = '已儲存 ✓（前台首頁約 1 分鐘內更新）'; msg.style.color = 'var(--green)'; msg.style.display = '';
        } catch (ex) { msg.textContent = ex.message; msg.style.color = 'var(--red)'; msg.style.display = ''; }
      };
      host.innerHTML = '';
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, '計畫說明'),
          h('button', { className: 'btn-accent', onClick: save }, '儲存')),
        h('p', { className: 'pa-hint' }, '顯示於前台首頁「最新公告」下方。內文清空後儲存，前台就不顯示這個區塊。'),
        h('div', { className: 'pa-form' },
          h('label', { className: 'pa-field' }, h('span', null, '區塊標題'), title),
          h('label', { className: 'pa-field' }, h('span', null, '內文', infoTip('「標題」用於「一、二、三」大段，「小標」用於「（一）（二）」小段。')), body),
          msg,
          h('div', { className: 'pa-form-foot' }, h('button', { className: 'btn-accent', onClick: save }, '儲存')))));
      try { await loadTinyMce(); } catch (e) { /* 載入失敗 → 下方退回 textarea */ }
      if (!initTinyMce(body, cur.html || '')) {
        body.setAttribute('rows', '16');
        body.style.cssText = 'width:100%;font-family:inherit';
        body.value = cur.html || '';
      }
    })();
    return host;
  }

  // 系統設定：聯絡資訊
  function settingsResource() {
    const host = h('div');
    (async () => {
      host.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
      const { settings } = await api('/settings');
      const c = settings.contact || {};
      const f = {};
      f.address = h('input', { type: 'text', value: c.address || '' });
      f.tel = h('input', { type: 'text', value: c.tel || '' });
      f.fax = h('input', { type: 'text', value: c.fax || '' });
      f.email = h('input', { type: 'text', value: c.email || '' });
      const msg = h('div', { className: 'pa-err' }); msg.style.display = 'none';
      const save = async () => {
        try {
          await api('/settings/contact', { method: 'PUT', body: { value: { address: f.address.value.trim(), tel: f.tel.value.trim(), fax: f.fax.value.trim(), email: f.email.value.trim() } } });
          msg.textContent = '已儲存 ✓'; msg.style.color = 'var(--green)'; msg.style.display = '';
        } catch (ex) { msg.textContent = ex.message; msg.style.color = 'var(--red)'; msg.style.display = ''; }
      };
      host.innerHTML = '';
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, '系統設定')),
        h('div', { className: 'pa-form' },
          h('h3', { style: 'margin:0 0 6px;font-size:15px;color:var(--navy)' }, '聯絡資訊（前台聯絡我們頁）'),
          h('div', { className: 'pa-form-row' },
            h('label', { className: 'pa-field' }, h('span', null, '地址'), f.address),
            h('label', { className: 'pa-field' }, h('span', null, '電話'), f.tel)),
          h('div', { className: 'pa-form-row' },
            h('label', { className: 'pa-field' }, h('span', null, '傳真'), f.fax),
            h('label', { className: 'pa-field' }, h('span', null, '電子郵件'), f.email)),
          msg,
          h('div', { className: 'pa-form-foot' }, h('button', { className: 'btn-accent', onClick: save }, '儲存設定')))));
    })();
    return host;
  }

  // 檔案模組：文件 / 分類 子導覽
  function downloadsResource(arg) {
    return subnavModule('downloads', [['docs', '文件'], ['cats', '分類']], arg, (cur, area) => {
      area.appendChild(genericResource(cur === 'docs' ? RES.documents : RES.documentCategories, 'downloads'));
    });
  }

  // ── 共用：模組內頁籤導覽（如公告的「公告／分類」、關於我們的五個頁籤）──────
  // 網址同步 #module 或 #module/tab（第一個 tab 是預設，網址上省略），讓瀏覽器上一頁／
  // 下一頁、或直接開網址都能正確對到當時的頁籤，而不是整個跳出模組（見公告分類設定
  // 一開始沒有自己的網址那個問題）。
  // tabs：[[key,label], ...]。
  // arg：來自 #module/arg 深連結。若剛好等於某個 tab key 就切去該頁籤；否則視為「留給
  //   預設頁籤自己用」的參數（如 #announcements/5 直接開某則公告編輯頁），只套用一次，
  //   之後在頁籤間切換就不會再套用。
  // paint(cur, area, deepArg)：依目前頁籤把內容塞進 area，可以是 async。
  function subnavModule(moduleKey, tabs, arg, paint) {
    const host = h('div');
    const defaultKey = tabs[0][0];
    let cur = tabs.some(([k]) => k === arg) ? arg : defaultKey;
    let deepArg = cur === defaultKey ? arg : null;
    async function render() {
      if (window.tinymce) tinymce.remove();
      host.innerHTML = '';
      const bar = h('div', { className: 'pa-subnav' }, tabs.map(([k, l]) =>
        h('button', { className: 'pa-subbtn' + (cur === k ? ' pa-subbtn-active' : ''), onClick: () => {
          if (k === cur) return;
          cur = k;
          const t = '#' + moduleKey + (k === defaultKey ? '' : '/' + k);
          if (location.hash !== t) history.pushState(null, '', t);
          render();
        } }, l)));
      const area = h('div');
      host.appendChild(h('div', null, bar, area));
      await paint(cur, area, deepArg);
      deepArg = null;
    }
    render();
    return host;
  }

  // ── generic resource (list ↔ form) ───────────────────────
  function genericResource(res, hashKey) {
    const host = h('div');
    // 搜尋關鍵字／篩選值宣告在這層（不是 showList 內部），換頁或存檔後回列表
    // （backToList → showList）才會保留篩選狀態，比照 annResource 的做法。
    let query = '';
    let filterVal = '';
    // 列表→編輯／新增一律走 openForm()：有 hashKey 才會同步網址（見 enterDetail/leaveDetail）；
    // 「返回列表」／存檔成功一律走 backToList()，兩者搭配讓瀏覽器上一頁能回到列表。
    function openForm(id) { if (hashKey) enterDetail(hashKey, id); showForm(id); }
    function backToList() { if (!hashKey || !leaveDetail(hashKey)) showList(); }
    async function showList() {
      host.innerHTML = '';
      // res.filterable 指向某個 ref 型欄位（如 category_id）：抓一次該欄位的完整清單，
      // 同時用來（1）把清單裡的 id 欄位換成可讀名稱、（2）當篩選下拉的選項。
      const filterField = res.filterable && res.fields.find((f) => f.col === res.filterable);
      const refItems = filterField ? (await api(filterField.ref)).items : [];
      const refLabel = Object.fromEntries(refItems.map((it) => [String(it.id), it[filterField.refLabel || 'name']]));
      const headers = [...res.cols.map((c) => c[1]), '操作'];
      const rowEl = (it) => h('tr', null,
        ...res.cols.map((c) => h('td', null, c[0] === res.filterable ? (refLabel[String(it[c[0]])] || '—') : fmtCell(it[c[0]], c[2]))),
        h('td', null, h('div', { className: 'pa-actions' },
          res.download
            ? (it[res.download]
              ? h('a', { className: 'btn-ghost btn-sm', style: 'text-decoration:none', href: '/api/admin' + res.api + '/' + it.id + '/download', target: '_blank', rel: 'noopener noreferrer' }, '下載')
              : h('button', { className: 'btn-ghost btn-sm', disabled: 'disabled', title: '尚未上傳檔案，無法下載。' }, '下載'))
            : null,
          h('button', { className: 'btn-ghost btn-sm', onClick: () => openForm(it.id) }, '編輯'),
          h('button', { className: 'btn-danger btn-sm', onClick: () => del(it.id) }, '刪除'))));
      const renderTable = (items) => h('table', { className: 'pa-table' },
        h('thead', null, h('tr', null, headers.map((t) => h('th', null, t)))),
        h('tbody', null, items.length ? items.map(rowEl) : h('tr', null, h('td', { colspan: String(headers.length), style: 'text-align:center;color:#999;padding:26px' }, (query || filterVal) ? '查無符合的資料' : '尚無資料'))));
      const headerBar = h('div', { className: 'pa-h' }, h('h2', null, res.title),
        h('button', { className: 'btn-accent btn-sm', onClick: () => openForm(null) }, '＋ 新增'));
      const listNote = res.listNote ? h('p', { className: 'pa-hint', style: 'margin:-6px 0 12px' }, res.listNote) : null;
      const qs = () => (query ? '&q=' + encodeURIComponent(query) : '') + (filterVal ? '&' + res.filterable + '=' + encodeURIComponent(filterVal) : '');
      const pager = res.paginate ? makePager((offset) => api(res.api + '?limit=50&offset=' + offset + qs()), renderTable) : null;
      let toolbar = null;
      if (res.searchable || res.filterable) {
        const search = h('input', { type: 'text', value: query, placeholder: typeof res.searchable === 'string' ? res.searchable : '搜尋…', style: 'min-width:200px' });
        const doSearch = () => { query = search.value.trim(); pager ? pager.load(true) : showList(); };
        search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
        const filterSel = res.filterable ? h('select', { style: 'min-width:140px' },
          [['', '全部分類'], ...refItems.map((it) => [String(it.id), it[filterField.refLabel || 'name']])]
            .map(([v, l]) => h('option', { value: v, ...(String(filterVal) === v ? { selected: 'selected' } : {}) }, l))) : null;
        if (filterSel) filterSel.addEventListener('change', () => { filterVal = filterSel.value; pager ? pager.load(true) : showList(); });
        const hasFilter = query || filterVal;
        toolbar = h('div', { className: 'pa-subnav' }, filterSel, search,
          h('button', { className: 'btn-ghost btn-sm', onClick: doSearch }, '搜尋'),
          hasFilter ? h('button', { className: 'btn-ghost btn-sm', onClick: () => { query = ''; filterVal = ''; search.value = ''; if (filterSel) filterSel.value = ''; pager ? pager.load(true) : showList(); } }, '清除') : null);
      }
      if (res.paginate) {
        host.appendChild(h('div', null, headerBar, listNote, toolbar, pager.listHost, pager.moreWrap));
        pager.load(true);
      } else {
        const { items } = await api(res.api + (qs() ? '?' + qs().slice(1) : ''));
        host.appendChild(h('div', null, headerBar, listNote, toolbar, renderTable(items)));
      }
    }
    async function del(id) {
      if (!confirm('確定刪除？此動作無法復原。')) return;
      try { await api(res.api + '/' + id, { method: 'DELETE' }); showList(); }
      catch (ex) { alert('刪除失敗：' + ex.message); }
    }
    async function showForm(id) {
      host.innerHTML = ''; host.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
      let item = {};
      if (id) item = (await api(res.api + '/' + id)).item;
      const ctrls = {};
      const refData = {};
      for (const rf of res.fields) if (rf.type === 'ref') refData[rf.col] = (await api(rf.ref)).items;
      // 按鈕「參數」下拉的選項：只有帶按鈕欄位的模組（輪播）才抓
      const btnArgs = res.fields.some((rf) => rf.type === 'buttons') ? await loadBtnArgOptions() : null;
      const fieldRow = (f) => {
        const v = item[f.col];
        if (f.type === 'hidden') { const el = h('input', { type: 'hidden', value: v == null ? '' : v }); ctrls[f.col] = { el, f }; return el; }
        if (f.type === 'file') {
          const hid = h('input', { type: 'hidden', value: v == null ? '' : v });
          const ctrl = { el: hid, f, pendingFile: null };
          ctrls[f.col] = ctrl;
          const status = h('span', { className: 'pa-hint' }, v ? ('目前：' + v + '（重新選擇以更換）') : '尚未選擇檔案');
          const picker = h('input', { type: 'file', ...(f.accept ? { accept: f.accept } : {}) });
          picker.addEventListener('change', () => {
            const file = picker.files && picker.files[0];
            if (!file) return;
            ctrl.pendingFile = file;
            status.textContent = '已選擇：' + file.name + '（' + fmtBytes(file.size) + '，按下方「儲存」時才會實際上傳）';
            // fillCol：檔名（去副檔名）自動帶入另一欄位（如「檔名」）。只在該欄目前是空的，或內容
            // 仍等於上次自動帶入的值時才覆蓋——換一個檔案會重新抓檔名，但不會蓋掉使用者自己改過的內容。
            if (f.fillCol && ctrls[f.fillCol]) {
              const nameCtrl = ctrls[f.fillCol];
              const base = file.name.replace(/\.[^.]+$/, '');
              if (!nameCtrl.el.value || nameCtrl.el.value === nameCtrl.autoFilled) {
                nameCtrl.el.value = base;
                nameCtrl.autoFilled = base;
              }
            }
          });
          return h('label', { className: 'pa-field' }, h('span', null, f.label + (f.req ? ' ＊' : '')),
            picker, status,
            f.hint ? h('span', { className: 'pa-hint' }, f.hint) : null, hid);
        }
        if (f.type === 'image') {
          // 圖片欄位：預覽＋選檔＋移除。跟 type:'file' 一樣延後到按「儲存」才上傳，選了又取消不會留孤兒檔；
          // 存的是 /files/… 網址（比照相簿照片），舊資料的 assets/… 靜態路徑也能預覽。
          const hid = h('input', { type: 'hidden', value: v == null ? '' : v });
          const ctrl = { el: hid, f, pendingFile: null };
          ctrls[f.col] = ctrl;
          const preview = h('img', { className: 'pa-img-preview-wide', alt: '' });
          const status = h('span', { className: 'pa-hint' });
          const picker = h('input', { type: 'file', accept: f.accept || IMAGE_ACCEPT });
          const clr = h('button', { className: 'btn-ghost btn-sm', type: 'button' }, '移除');
          let objUrl = null;
          const paint = () => {
            const src = ctrl.pendingFile ? objUrl : assetUrl(hid.value);
            preview.src = src || ''; preview.style.display = src ? '' : 'none';
            clr.style.display = (hid.value || ctrl.pendingFile) ? '' : 'none';
            status.textContent = ctrl.pendingFile
              ? '已選擇：' + ctrl.pendingFile.name + '（' + fmtBytes(ctrl.pendingFile.size) + '，按下方「儲存」時才會實際上傳）'
              : hid.value ? '目前：' + hid.value + '（重新選擇即可更換）' : (f.emptyText || '尚未設定');
          };
          picker.addEventListener('change', () => {
            const file = picker.files && picker.files[0];
            if (!file) return;
            const ext = (file.name || '').toLowerCase().split('.').pop();
            if (IMAGE_EXT.indexOf(ext) === -1) { picker.value = ''; status.textContent = '只能選擇圖片檔（' + IMAGE_EXT.join('、') + '）'; return; }
            if (file.size > MAX_UPLOAD) { picker.value = ''; status.textContent = '檔案大小超過上限 15MB（此檔 ' + fmtBytes(file.size) + '）'; return; }
            if (objUrl) URL.revokeObjectURL(objUrl);
            objUrl = URL.createObjectURL(file);
            ctrl.pendingFile = file; paint();
          });
          clr.addEventListener('click', () => {
            hid.value = ''; ctrl.pendingFile = null; picker.value = '';
            if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
            paint(); status.textContent = '已移除（按下方「儲存」後生效）';
          });
          paint();
          return h('label', { className: 'pa-field' }, h('span', null, f.label + (f.req ? ' ＊' : '')),
            h('div', { style: 'display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap' },
              preview,
              h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, picker, clr)),
            status, f.hint ? h('span', { className: 'pa-hint' }, f.hint) : null, hid);
        }
        if (f.type === 'buttons') {
          const PAGES = [['', '（不連結）'], ['home', '首頁'], ['news', '最新公告'], ['downloads', '檔案下載'], ['contact', '聯絡我們'], ['external', '任意網站（外部連結）']];
          const listEl = h('div', { className: 'pa-btnlist' });
          const rows = [];
          const addRow = (b) => {
            b = b || {};
            const isExt = (b.target_page || '') === 'external' || (!b.target_page && b.url);
            const label = h('input', { type: 'text', value: b.label || '', placeholder: '按鈕文字（如：觀看剪綵相簿 →）' });
            const page = h('select', null, PAGES.map(([pv, pl]) => h('option', { value: pv, ...(((isExt ? 'external' : (b.target_page || '')) === pv) ? { selected: 'selected' } : {}) }, pl)));
            // 「參數」依「連結到」的頁面換成對應的下拉（相簿／公告分類／檔案分類／會員分頁）；
            // 沒有參數可選的頁面直接隱藏。舊資料若存的是分類名稱或已刪除的目標，補一個「目前值」選項保住它。
            const arg = h('select', null);
            let argVal = b.target_arg == null ? '' : String(b.target_arg);
            const url = h('input', { type: 'url', value: b.url || '', placeholder: 'https://example.com（會另開分頁）' });
            const primary = h('input', { type: 'checkbox', checked: !!b.is_primary });
            const rowObj = { label, page, arg, url, primary };
            rows.push(rowObj);
            const argLabel = h('span', null, '參數');
            const argField = h('label', { className: 'pa-field' }, argLabel, arg);
            const urlField = h('label', { className: 'pa-field' }, h('span', null, '網址（另開分頁）'), url);
            const fillArg = () => {
              const spec = btnArgs && btnArgs[page.value];
              arg.innerHTML = '';
              if (!spec) { argField.style.display = 'none'; arg.value = ''; return; }
              argField.style.display = '';
              argLabel.textContent = spec.label;
              arg.appendChild(h('option', { value: '' }, spec.none));
              spec.options.forEach(([ov, ol]) => arg.appendChild(h('option', { value: ov }, ol)));
              if (argVal && !spec.options.some(([ov]) => ov === argVal)) arg.appendChild(h('option', { value: argVal }, '（目前值：' + argVal + '，找不到對應項目）'));
              arg.value = argVal;
            };
            arg.addEventListener('change', () => { argVal = arg.value; });
            const setMode = () => {
              const ext = page.value === 'external';
              urlField.style.display = ext ? '' : 'none';
              if (ext) argField.style.display = 'none'; else fillArg();
            };
            // 換了目標頁面，原本的參數就不適用（相簿代碼對檔案分類沒意義），清掉重選
            page.addEventListener('change', () => { argVal = ''; setMode(); }); setMode();
            const card = h('div', { className: 'pa-btnrow' },
              h('div', { className: 'pa-btnrow-grid' },
                h('label', { className: 'pa-field' }, h('span', null, '按鈕文字'), label),
                h('label', { className: 'pa-field' }, h('span', null, '連結到'), page),
                argField, urlField),
              h('div', { className: 'pa-btnrow-foot' },
                h('label', { className: 'pa-check' }, primary, '主要按鈕（金色實心）'),
                h('button', { className: 'btn-danger btn-sm', type: 'button', onClick: () => { const i = rows.indexOf(rowObj); if (i > -1) rows.splice(i, 1); card.remove(); syncAdd(); } }, '移除')));
            listEl.appendChild(card);
            syncAdd();
          };
          const MAX = f.max || 3;
          const addBtn = h('button', { className: 'btn-ghost btn-sm', type: 'button', style: 'align-self:flex-start' }, '＋ 新增按鈕');
          const capNote = h('span', { className: 'pa-hint' }, '已達上限（最多 ' + MAX + ' 顆），如需替換請先移除。');
          function syncAdd() { const full = rows.length >= MAX; addBtn.style.display = full ? 'none' : ''; capNote.style.display = full ? '' : 'none'; }
          addBtn.addEventListener('click', () => addRow({}));
          (Array.isArray(v) ? v : []).forEach(addRow);
          syncAdd();
          ctrls[f.col] = { el: { rows }, f };
          return h('div', { className: 'pa-field' }, h('span', null, f.label, f.hint ? infoTip(f.hint) : null),
            listEl, addBtn, capNote);
        }
        if (f.type === 'radio') {
          const cur = v == null ? f.options[0][0] : v;
          const hid = h('input', { type: 'hidden', value: cur });
          const radios = [];
          const name = 'radio-' + f.col + '-' + Math.random().toString(36).slice(2);
          const opts = f.options.map(([ov, ol]) => {
            const r = h('input', { type: 'radio', name, value: ov, checked: cur === ov });
            r.addEventListener('change', () => { if (r.checked) hid.value = ov; });
            radios.push(r);
            return h('label', { className: 'pa-check' }, r, ol);
          });
          ctrls[f.col] = { el: hid, f, radios };
          // lockedBy：依另一個 ref 欄位目前選的項目之某欄位值，鎖定本欄選項——只有值落在
          // f.lockedBy.only 清單內才鎖（不給 only 則沿用舊行為：值等於任一 option 就鎖）。
          // documents 的 access 只在分類 access_scope='member' 時鎖成會員限定；「公開」與
          // 「公開＋會員」分類底下的檔案本就允許公開／會員限定自由混放，不鎖。
          const lockHint = f.lockedBy ? h('span', { className: 'pa-hint pa-lock-hint' }) : null;
          if (f.lockedBy && ctrls[f.lockedBy.ref]) {
            const refItems = refData[f.lockedBy.ref] || [];
            const srcSel = ctrls[f.lockedBy.ref].el;
            const lockable = f.lockedBy.only || f.options.map(([ov]) => ov);
            const applyLock = () => {
              const refItem = refItems.find((it) => String(it.id) === String(srcSel.value));
              const lockVal = refItem ? refItem[f.lockedBy.col] : null;
              const locked = lockable.includes(lockVal);
              radios.forEach((r) => { r.disabled = locked; if (locked && r.value === lockVal) { r.checked = true; hid.value = lockVal; } });
              if (lockHint) lockHint.textContent = locked ? '此分類已固定「權限」，如需改變請調整分類設定。' : '';
            };
            srcSel.addEventListener('change', applyLock);
            applyLock();
          }
          return h('div', { className: 'pa-field' }, h('span', null, f.label + (f.req ? ' ＊' : '')),
            h('div', { className: 'pa-checkrow' }, opts),
            f.hint ? h('span', { className: 'pa-hint' }, f.hint) : null, lockHint, hid);
        }
        let el;
        if (f.type === 'textarea') el = h('textarea', { rows: '4', value: v == null ? '' : v });
        else if (f.type === 'lines') el = h('textarea', { rows: '4', value: Array.isArray(v) ? v.join('\n') : '' });
        else if (f.type === 'json') el = h('textarea', { rows: '7', value: v ? JSON.stringify(v, null, 2) : '' });
        // default：新增時（v 尚無值）預設帶入的數字，沒設就是 0；編輯既有資料一律照實際值。
        else if (f.type === 'int') el = h('input', { type: 'number', value: v == null ? (f.default != null ? f.default : 0) : v });
        else if (f.type === 'color') el = h('input', { type: 'color', value: (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : '#1f3a5f' });
        // today:true → 新增時預設帶今天（如檔案的「更新日期」＝上傳日），仍可自行改。
        else if (f.type === 'date') el = h('input', { type: 'date', value: v ? String(v).slice(0, 10) : (f.today && !id ? new Date().toISOString().slice(0, 10) : '') });
        // defaultChecked：新增時（v 尚無值）預設勾選，編輯既有資料時一律照實際值來，不覆蓋。
        else if (f.type === 'bool') el = h('input', { type: 'checkbox', checked: v == null ? !!f.defaultChecked : !!v });
        else if (f.type === 'ref') el = h('select', null, (refData[f.col] || []).map((o) => h('option', { value: o.id, ...(Number(v) === o.id ? { selected: 'selected' } : {}) }, o[f.refLabel || 'name'])));
        else if (f.type === 'select') el = h('select', null, f.options.map(([ov, ol]) => h('option', { value: ov, ...(v === ov ? { selected: 'selected' } : {}) }, ol)));
        else el = h('input', { type: 'text', value: v == null ? '' : v });
        ctrls[f.col] = { el, f };
        if (f.type === 'bool') return h('label', { className: 'pa-check' }, el, f.label);
        return h('label', { className: 'pa-field' }, h('span', null, f.label + (f.req ? ' ＊' : '')), el, f.hint ? h('span', { className: 'pa-hint' }, f.hint) : null);
      };
      const err = h('div', { className: 'pa-err' }); err.style.display = 'none';
      const saveMsg = h('span', { className: 'pa-hint' });
      const saveBtn = h('button', { className: 'btn-accent', onClick: () => save() }, '儲存');
      const save = async () => {
        err.style.display = '';
        err.style.color = 'var(--red)'; err.style.display = 'none';
        saveBtn.disabled = true;
        saveMsg.textContent = '儲存執行中，請勿離開頁面…';
        // 有選檔案但尚未上傳的欄位，存檔前才真正上傳（scopeFrom 讀的是「此刻」表單上的值，
        // 此時其他欄位都已填好，跟檔案欄位在表單上的先後順序無關）。
        for (const k in ctrls) {
          const ctrl = ctrls[k];
          if ((ctrl.f.type !== 'file' && ctrl.f.type !== 'image') || !ctrl.pendingFile) continue;
          try {
            const scope = (ctrl.f.scopeFrom && ctrls[ctrl.f.scopeFrom] && ctrls[ctrl.f.scopeFrom].el.value === 'member') ? 'member' : undefined;
            const up = await apiUpload(ctrl.pendingFile, ctrl.f.prefix, scope);
            // file 欄存 R2 key（前台自行加 /files/）；image 欄存完整網址，前台直接拿來用
            ctrl.el.value = ctrl.f.type === 'image' ? up.url : up.key;
            if (ctrl.f.sizeCol && ctrls[ctrl.f.sizeCol]) ctrls[ctrl.f.sizeCol].el.value = up.size;
            if (ctrl.f.typeCol && ctrls[ctrl.f.typeCol]) ctrls[ctrl.f.typeCol].el.value = up.type;
            ctrl.pendingFile = null;
          } catch (ex) { saveBtn.disabled = false; saveMsg.textContent = ''; err.textContent = '檔案上傳失敗：' + ex.message; err.style.display = ''; return; }
        }
        const payload = {};
        try {
          for (const k in ctrls) {
            const { el, f } = ctrls[k];
            if (f.type === 'bool') payload[k] = el.checked;
            else if (f.type === 'int') payload[k] = Number(el.value);
            else if (f.type === 'lines') payload[k] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
            else if (f.type === 'buttons') payload[k] = el.rows.map((r) => { const ext = r.page.value === 'external'; return { label: r.label.value.trim(), target_page: r.page.value || null, target_arg: ext ? null : (r.arg.value.trim() || null), url: ext ? (r.url.value.trim() || null) : null, is_primary: r.primary.checked }; }).filter((b) => b.label);
            else if (f.type === 'json') payload[k] = el.value.trim() ? JSON.parse(el.value) : null;
            else if (f.type === 'ref') payload[k] = el.value ? Number(el.value) : null;
            else if (f.type === 'file' || f.type === 'image' || f.type === 'hidden' || f.type === 'radio') payload[k] = el.value || null;
            else payload[k] = el.value.trim() || null;
          }
        } catch (ex) { saveBtn.disabled = false; saveMsg.textContent = ''; err.textContent = 'JSON 格式錯誤：' + ex.message; err.style.display = ''; return; }
        try {
          if (id) await api(res.api + '/' + id, { method: 'PUT', body: payload });
          else await api(res.api, { method: 'POST', body: payload });
          backToList();
        } catch (ex) { saveBtn.disabled = false; saveMsg.textContent = ''; err.textContent = ex.message; err.style.display = ''; }
      };
      host.innerHTML = '';
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, (id ? '編輯' : '新增') + res.title),
          h('button', { className: 'btn-ghost', onClick: backToList }, '← 返回')),
        h('div', { className: 'pa-form' }, res.fields.map(fieldRow), err,
          h('div', { className: 'pa-form-foot' },
            saveBtn,
            h('button', { className: 'btn-ghost', onClick: backToList }, '取消'), saveMsg))));
    }
    showList();
    return host;
  }

  // ── 法律頁面（服務條款／隱私權政策；固定兩筆，列表＋編輯）──────
  // blocks 欄位沿用公告內文的雙格式慣例（見 blocksToHtml／initTinyMce）：
  // 字串＝TinyMCE 產生的 HTML，陣列＝舊版區塊 JSON（服務條款/隱私權政策目前既有內容就是這種）。
  function legalResource(arg) {
    const host = h('div');
    const LEGAL_LABEL = { terms: '服務條款', privacy: '隱私權政策' };
    function showList() {
      // 離開編輯畫面時清掉舊的 TinyMCE 執行個體（同 announcementsResource 的做法）：
      // 不清的話下一次進編輯頁會撞到同一個 id（legal-body），新的編輯器初始化不出來，
      // 內文會變成空白的純 textarea。
      if (window.tinymce) tinymce.remove();
      host.innerHTML = ''; host.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
      api('/legal').then(({ items }) => {
        const rows = items.map((it) => h('tr', null,
          h('td', null, LEGAL_LABEL[it.key] || it.key),
          h('td', null, it.title || '—'),
          h('td', null, it.updated_date || '—'),
          h('td', null, h('button', { className: 'btn-ghost btn-sm', onClick: () => showForm(it.key) }, '編輯'))));
        host.innerHTML = '';
        host.appendChild(h('div', null,
          h('div', { className: 'pa-h' }, h('h2', null, '法律頁面')),
          h('p', { className: 'pa-hint' }, '前台網址分別是 /terms、/privacy。'),
          h('table', { className: 'pa-table' },
            h('thead', null, h('tr', null, ['頁面', '標題', '最後更新', '操作'].map((t) => h('th', null, t)))),
            h('tbody', null, rows))));
      });
    }
    async function showForm(key) {
      if (window.tinymce) tinymce.remove();
      host.innerHTML = ''; host.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
      const { item } = await api('/legal/' + key);
      const f = {};
      f.title = h('input', { type: 'text', value: item.title || '' });
      f.title_en = h('input', { type: 'text', value: item.title_en || '' });
      // 純文字（非 <input type=date>）：既有內容存的是「中華民國115年8月12日」這種自由格式，
      // 不是 ISO 日期，塞進 type=date 會直接被瀏覽器判為無效值、顯示空白。
      f.updated_date = h('input', { type: 'text', value: item.updated_date || '', placeholder: '例：中華民國115年8月12日' });
      f.body = h('textarea', { id: 'legal-body', className: 'pa-richtext' });
      const err = h('div', { className: 'pa-err' }); err.style.display = 'none';

      const save = async () => {
        err.style.display = 'none';
        const ed = window.tinymce && tinymce.get('legal-body');
        const html = ed ? ed.getContent() : (f.body.value || '');
        const payload = {
          title: f.title.value.trim(), title_en: f.title_en.value.trim() || null,
          updated_date: f.updated_date.value || null,
          blocks: (html && html !== '<p><br></p>') ? html : '',
        };
        try { await api('/legal/' + key, { method: 'PUT', body: payload }); showList(); }
        catch (ex) { err.textContent = ex.message; err.style.display = ''; }
      };
      host.innerHTML = '';
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, '編輯：' + (LEGAL_LABEL[key] || key)),
          h('div', { style: 'display:flex;gap:8px' },
            h('button', { className: 'btn-accent', onClick: save }, '儲存'),
            h('button', { className: 'btn-ghost', onClick: showList }, '← 返回列表'))),
        h('div', { className: 'pa-form' },
          h('div', { className: 'pa-form-row' },
            h('label', { className: 'pa-field' }, h('span', null, '標題'), f.title),
            h('label', { className: 'pa-field' }, h('span', null, '英文標題（選填）'), f.title_en)),
          h('label', { className: 'pa-field', style: 'max-width:280px' }, h('span', null, '最後更新日期'), f.updated_date),
          h('label', { className: 'pa-field' }, h('span', null, '內文', infoTip('所見即所得：工具列可設標題、粗體、清單、連結、表格。')), f.body),
          err,
          h('div', { className: 'pa-form-foot' },
            h('button', { className: 'btn-accent', onClick: save }, '儲存'),
            h('button', { className: 'btn-ghost', onClick: showList }, '取消')))));
      const bodyHtml = blocksToHtml(item.blocks);
      try { await loadTinyMce(); } catch (e) { /* 載入失敗 → 下方退回 textarea */ }
      if (!initTinyMce(f.body, bodyHtml)) {
        f.body.setAttribute('rows', '12');
        f.body.style.cssText = 'width:100%;font-family:inherit';
        f.body.value = bodyHtml;
      }
    }
    if (LEGAL_LABEL[arg]) showForm(arg); else showList();
    return host;
  }

  // ── announcements (custom: visibility-linked category + body blocks) ──────
  const bodyToText = (blocks) => {
    if (!blocks || !blocks.length) return '';
    if (blocks.every((b) => Object.keys(b).length === 1 && 'p' in b)) return blocks.map((b) => b.p).join('\n\n');
    return JSON.stringify(blocks, null, 2);
  };
  const textToBody = (t) => {
    t = (t || '').trim();
    if (!t) return null;
    if (t[0] === '[') { try { const j = JSON.parse(t); if (Array.isArray(j)) return j; } catch { /* fall through */ } }
    return t.split(/\n\s*\n/).map((p) => ({ p: p.trim() })).filter((b) => b.p);
  };

  // 公告模組外層：子導覽切換「公告 ↔ 分類管理」（分類沿用通用 CRUD）
  // arg：來自 #announcements/<id 或 cats> 深連結。數字＝直接開該則公告的編輯頁；
  // 'cats'＝直接開分類頁籤（見 subnavModule）。
  function announcementsResource(arg) {
    return subnavModule('announcements', [['list', '公告'], ['cats', '分類']], arg, (cur, area, deepArg) => {
      if (cur === 'list') { cats = null; area.appendChild(annResource(deepArg)); } // 重載分類快取，反映剛編輯的分類
      else area.appendChild(genericResource(RES.announcementCategories, 'announcements'));
    });
  }

  function annResource(openId) {
    const host = h('div');
    let query = '';
    let categoryId = '';   // 分類篩選（空＝全部）
    let statusFilter = ''; // 狀態篩選（空＝全部）
    let visFilter = '';    // 顯示對象篩選（空＝全部）
    // 列表→編輯／新增一律走 openForm()：會把網址推成 #announcements/<id 或 new>，
    // 讓瀏覽器上一頁能回到列表；「返回列表」／存檔成功一律走 backToList()。
    const openForm = (id) => { enterDetail('announcements', id); showForm(id); };
    const backToList = () => { if (!leaveDetail('announcements')) showList(); };
    async function showList() {
      if (window.tinymce) tinymce.remove();
      host.innerHTML = '';
      if (!cats) cats = (await api('/categories')).items;
      const nw = { style: 'white-space:nowrap' };
      // 「前台觀看」：另開分頁到前台實際頁面。前台看得到的只有「公開＋已發布」；
      // 限定公告與草稿／下架前台都不會回傳，故只有「公開＋已發布」能點。
      const viewBtn = (a) => {
        if (a.status !== 'published') {
          return h('button', { className: 'btn-ghost btn-sm', disabled: 'disabled',
            title: '「' + ({ draft: '草稿', scheduled: '已排程', archived: '下架' })[a.status] + '」的公告前台不會顯示，請先改為「已發布」。' }, '前台觀看');
        }
        if (a.visibility === 'member') {
          return h('button', { className: 'btn-ghost btn-sm', disabled: 'disabled',
            title: '限定公告前台不會顯示。' }, '前台觀看');
        }
        return h('a', { className: 'btn-ghost btn-sm', href: '/news/' + a.id, target: '_blank', rel: 'noopener', style: 'text-decoration:none',
          title: '另開分頁檢視前台頁面' }, '前台觀看');
      };
      const rowEl = (a) => h('tr', null,
        h('td', nw, h('span', { className: 'pa-tag ' + (a.visibility === 'member' ? 'pa-vis-member' : 'pa-vis-public') }, a.visibility === 'member' ? '會員' : '公開')),
        h('td', nw, h('span', { className: 'pa-st-' + a.status }, ({ draft: '草稿', scheduled: '已排程', published: '已發布', archived: '下架' })[a.status] || a.status)),
        h('td', nw, a.category),
        h('td', null, (a.is_pinned ? h('span', { className: 'pa-tag pa-pin' }, '置頂') : ''), a.title),
        h('td', nw, a.publish_date),
        h('td', null, String(a.views)),
        h('td', null, h('div', { className: 'pa-actions' },
          h('button', { className: 'btn-ghost btn-sm', onClick: () => openForm(a.id) }, '編輯'),
          viewBtn(a),
          h('button', { className: 'btn-danger btn-sm', onClick: () => del(a.id, a.title) }, '刪除'))));
      const renderTable = (items) => h('table', { className: 'pa-table' },
        h('thead', null, h('tr', null, ['對象', '狀態', '分類', '標題', '發布日期', '瀏覽', '操作'].map((t) => h('th', null, t)))),
        h('tbody', null, items.length ? items.map(rowEl) : h('tr', null, h('td', { colspan: '7', style: 'text-align:center;color:#999;padding:30px' }, (query || categoryId || statusFilter || visFilter) ? '查無符合的公告' : '尚無公告'))));
      const pager = makePager((offset) => api('/announcements?limit=50&offset=' + offset
        + (query ? '&q=' + encodeURIComponent(query) : '')
        + (categoryId ? '&category_id=' + encodeURIComponent(categoryId) : '')
        + (statusFilter ? '&status=' + statusFilter : '')
        + (visFilter ? '&visibility=' + visFilter : '')), renderTable);
      // 篩選下拉共用建構：opts 為 [value, label] 陣列，選中值 cur，變更即重載
      const filterSel = (cur, opts, onChange) => {
        const s = h('select', { style: 'min-width:120px' },
          opts.map(([v, l]) => h('option', { value: v, ...(String(cur) === String(v) ? { selected: 'selected' } : {}) }, l)));
        s.addEventListener('change', () => { onChange(s.value); pager.load(true); });
        return s;
      };
      const catSel = filterSel(categoryId, [['', '全部分類'], ...cats.map((cc) => [String(cc.id), cc.name + (cc.scope === 'member' ? '（會員）' : '')])], (v) => { categoryId = v; });
      const visSel = filterSel(visFilter, [['', '全部對象'], ['public', '公開'], ['member', '會員限定']], (v) => { visFilter = v; });
      const statusSel = filterSel(statusFilter, [['', '全部狀態'], ['draft', '草稿'], ['scheduled', '已排程'], ['published', '已發布'], ['archived', '下架']], (v) => { statusFilter = v; });
      const search = h('input', { type: 'text', value: query, placeholder: '搜尋標題…', style: 'min-width:200px' });
      const doSearch = () => { query = search.value.trim(); pager.load(true); };
      search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
      const hasFilter = query || categoryId || statusFilter || visFilter;
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, '公告管理'),
          h('button', { className: 'btn-accent btn-sm', onClick: () => openForm(null) }, '＋ 新增公告')),
        h('div', { className: 'pa-subnav' }, visSel, catSel, statusSel, search,
          h('button', { className: 'btn-ghost btn-sm', onClick: doSearch }, '搜尋'),
          hasFilter ? h('button', { className: 'btn-ghost btn-sm', onClick: () => { query = ''; categoryId = ''; statusFilter = ''; visFilter = ''; search.value = ''; catSel.value = ''; visSel.value = ''; statusSel.value = ''; pager.load(true); } }, '清除') : null),
        pager.listHost, pager.moreWrap));
      pager.load(true);
    }
    async function del(id, title) { if (!confirm('確定刪除「' + title + '」？此動作無法復原。')) return; await api('/announcements/' + id, { method: 'DELETE' }); showList(); }
    async function showForm(id) {
      if (window.tinymce) tinymce.remove();
      host.innerHTML = ''; host.appendChild(h('div', { className: 'pa-loading' }, '載入中…'));
      if (!cats) cats = (await api('/categories')).items;
      let item = { visibility: 'public', category_id: null, title: '', excerpt: '', body: null, publish_date: new Date().toISOString().slice(0, 10), is_pinned: false, show_in_list: true, status: 'draft' };
      let attachments = [];
      if (id) {
        // 深連結可能指向已刪除的公告，404 時退回列表而非卡在「載入中…」
        try { const resp = await api('/announcements/' + id); item = resp.item; attachments = resp.files || []; }
        catch (ex) { if (ex.status !== 404) throw ex; alert('找不到這則公告（可能已被刪除）。'); return backToList(); }
      }
      const f = {};
      f.visibility = h('select', null, ['public', 'member'].map((v) => h('option', { value: v, ...(item.visibility === v ? { selected: 'selected' } : {}) }, v === 'member' ? '會員限定' : '公開')));
      f.category = h('select');
      const fillCats = () => {
        const scope = f.visibility.value; f.category.innerHTML = '';
        cats.filter((c) => c.scope === scope).forEach((c) => f.category.appendChild(h('option', { value: c.id, ...(Number(item.category_id) === c.id ? { selected: 'selected' } : {}) }, c.name)));
      };
      fillCats(); f.visibility.addEventListener('change', fillCats);
      f.title = h('input', { type: 'text', value: item.title || '' });
      const _pd = item.publish_date || '';
      f.publish_date = h('input', { type: 'datetime-local', value: _pd ? (_pd.length <= 10 ? _pd + 'T00:00' : _pd.replace(' ', 'T').slice(0, 16)) : '' });
      f.status = h('select', null, [['draft', '草稿'], ['scheduled', '已排程'], ['published', '已發布'], ['archived', '下架']].map(([v, l]) => h('option', { value: v, ...(item.status === v ? { selected: 'selected' } : {}) }, l)));
      f.excerpt = h('textarea', { rows: '2', value: item.excerpt || '' });
      f.body = h('textarea', { id: 'ann-body', className: 'pa-richtext' });
      f.is_pinned = h('input', { type: 'checkbox', checked: !!item.is_pinned });
      f.show_in_list = h('input', { type: 'checkbox', checked: item.show_in_list !== 0 && item.show_in_list !== false });
      const err = h('div', { className: 'pa-err' }); err.style.display = 'none';
      const attachArea = h('div');
      function renderAttach() {
        attachArea.innerHTML = '';
        if (!id) { attachArea.appendChild(h('p', { className: 'pa-hint' }, '建立公告後即可上傳附件。')); return; }
        // 「需登入下載」開關：僅公開公告可個別調整；會員限定公告的附件一律隨公告，
        // 故以「已存檔」的 item.visibility 判斷（與伺服器端的規則一致）。
        const lockCell = (a) => {
          if (item.visibility === 'member') return h('span', { className: 'pa-hint' }, '🔒 隨公告需登入');
          const cb = h('input', { type: 'checkbox', checked: a.access === 'member' });
          const note = h('span', { className: 'pa-hint' });
          cb.addEventListener('change', async () => {
            const want = cb.checked ? 'member' : 'public';
            cb.disabled = true; note.textContent = '處理中…';
            try {
              const r = await api('/attachments/' + a.id + '/access', { method: 'PUT', body: { access: want } });
              a.access = r.access; a.file_path = r.file_path; note.textContent = '已更新';
            } catch (ex) { cb.checked = !cb.checked; note.textContent = ''; alert(ex.message); }
            cb.disabled = false;
          });
          return h('label', { className: 'pa-check', title: '勾選後此檔改存於會員專屬區，公開網址將無法下載' }, cb, '需登入下載', note);
        };
        // 前台檔案列顯示的「更新日期」。預設為上傳日，改了立即存（這一列沒有整體的儲存按鈕）。
        const dateCell = (a) => {
          const inp = h('input', { type: 'date', value: a.file_date ? String(a.file_date).slice(0, 10) : '', style: 'width:150px' });
          const note = h('span', { className: 'pa-hint' });
          inp.addEventListener('change', async () => {
            inp.disabled = true; note.textContent = '';
            try {
              await api('/attachments/' + a.id, { method: 'PUT', body: { file_date: inp.value || null } });
              a.file_date = inp.value || null; note.textContent = '已更新';
            } catch (ex) { inp.value = a.file_date || ''; alert(ex.message); }
            inp.disabled = false;
          });
          return h('label', { className: 'pa-check', title: '前台檔案列顯示的更新日期' }, '更新日期', inp, note);
        };
        const list = h('div', null, attachments.map((a) => h('div', { style: 'display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:wrap' },
          h('span', { className: 'pa-tag ' + (a.access === 'member' || item.visibility === 'member' ? 'pa-vis-member' : 'pa-vis-public') }, (a.type || 'pdf').toUpperCase()),
          h('span', { style: 'flex:1;min-width:120px' }, a.name),
          dateCell(a),
          lockCell(a),
          h('button', { className: 'btn-danger btn-sm', onClick: async () => { if (!confirm('刪除附件「' + a.name + '」？')) return; await api('/attachments/' + a.id, { method: 'DELETE' }); attachments = attachments.filter((x) => x.id !== a.id); renderAttach(); } }, '刪除'))));
        const picker = h('input', { type: 'file', accept: UPLOAD_ACCEPT });
        const status = h('span', { className: 'pa-hint' });
        const up = h('button', { className: 'btn-ghost btn-sm', type: 'button', onClick: async () => {
          const file = picker.files && picker.files[0];
          if (!file) { status.textContent = '請先選擇檔案'; return; }
          up.disabled = true; picker.disabled = true;
          status.textContent = '上傳執行中，請勿離開頁面…';
          try {
            const u = await apiUpload(file, 'attachments', f.visibility.value === 'member' ? 'member' : undefined);
            const r = await api('/announcements/' + id + '/attachments', { method: 'POST', body: { name: u.name, file_path: u.key, size_bytes: u.size, type: u.type } });
            attachments.push({ id: r.id, name: u.name, type: u.type, access: r.access, file_path: u.key, file_date: r.file_date });
            status.textContent = '已上傳'; renderAttach();
          } catch (ex) { up.disabled = false; picker.disabled = false; status.textContent = '上傳失敗：' + ex.message; }
        } }, '上傳附件');
        attachArea.appendChild(h('div', null,
          h('div', { className: 'pa-h' }, h('h3', { style: 'margin:0;font-size:15px;color:var(--navy)' }, '附件（' + attachments.length + '）')),
          list,
          h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px' }, picker, up, status)));
      }
      renderAttach();
      const save = async () => {
        err.style.display = 'none';
        const ed = window.tinymce && tinymce.get('ann-body');
        const html = ed ? ed.getContent() : (f.body.value || '');
        const payload = {
          visibility: f.visibility.value, category_id: Number(f.category.value), title: f.title.value.trim(),
          excerpt: f.excerpt.value.trim() || null, body: (html && html !== '<p><br></p>') ? html : null, publish_date: f.publish_date.value,
          is_pinned: f.is_pinned.checked, show_in_list: f.show_in_list.checked, status: f.status.value,
        };
        try {
          if (id) {
            const r = await api('/announcements/' + id, { method: 'PUT', body: payload });
            // 改為「會員限定」時附件會一併上鎖，個別失敗要讓管理者知道，不能默默放過
            if (r.warnings && r.warnings.length) alert('公告已儲存，但下列附件未能上鎖：\n\n' + r.warnings.join('\n'));
            backToList();
          }
          else { const r = await api('/announcements', { method: 'POST', body: payload }); resolveDetail('announcements', r.id); showForm(r.id); }
        } catch (ex) { err.textContent = ex.message; err.style.display = ''; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      };
      host.innerHTML = '';
      host.appendChild(h('div', null,
        h('div', { className: 'pa-h' }, h('h2', null, id ? '編輯公告' : '新增公告'),
          h('div', { style: 'display:flex;gap:8px' },
            h('button', { className: 'btn-accent', onClick: save }, '儲存'),
            h('button', { className: 'btn-ghost', onClick: backToList }, '← 返回列表'))),
        h('div', { className: 'pa-form' },
          // 設定類欄位集中在最上方（顯示對象／分類／日期／狀態＋置頂／顯示於列表），
          // 下方才是內容欄位（標題／摘要／內文），編輯時不必上下來回找。
          h('div', { className: 'pa-form-row' },
            h('label', { className: 'pa-field' }, h('span', null, '顯示對象'), f.visibility),
            h('label', { className: 'pa-field' }, h('span', null, '分類'), f.category),
            h('label', { className: 'pa-field' }, h('span', null, '發布日期時間', infoTip('前台只顯示日期；同一天有多則時，可用「時:分」調整顯示順序（時間較晚的排在前面）。狀態選「已排程」時，這個時間就是預約發布的時間。')), f.publish_date),
            h('label', { className: 'pa-field' }, h('span', null, '狀態', infoTip('已排程＝時間到了系統會自動改成「已發布」，不用手動操作；系統每 5 分鐘檢查一次，不會分秒不差，但最多差幾分鐘。')), f.status)),
          h('div', { className: 'pa-checkrow' },
            h('label', { className: 'pa-check' }, f.is_pinned, '置頂'),
            h('label', { className: 'pa-check' }, f.show_in_list, '顯示於列表', infoTip('取消勾選＝不出現在公告列表，但仍可經直接網址開啟（例如只想從輪播或選單連過去的公告）。'))),
          h('label', { className: 'pa-field' }, h('span', null, '標題'), f.title),
          h('label', { className: 'pa-field' }, h('span', null, '摘要'), f.excerpt),
          h('label', { className: 'pa-field' }, h('span', null, '內文', infoTip('所見即所得：工具列可設標題、粗體、清單、連結、圖片、表格。')), f.body),
          err,
          h('hr', { style: 'margin:20px 0;border:none;border-top:1px solid var(--line)' }),
          attachArea,
          h('div', { className: 'pa-form-foot', style: 'margin-top:22px' },
            h('button', { className: 'btn-accent', onClick: save }, '儲存'),
            h('button', { className: 'btn-ghost', onClick: backToList }, '取消')))));
      // 內文編輯器：TinyMCE（自架，動態載入；原生 HTML 進出）；載入失敗時退回純 textarea
      const bodyHtml = blocksToHtml(item.body);
      try { await loadTinyMce(); } catch (e) { /* 載入失敗 → 下方退回 textarea */ }
      if (!initTinyMce(f.body, bodyHtml)) {
        f.body.setAttribute('rows', '12');
        f.body.style.cssText = 'width:100%;font-family:inherit';
        f.body.value = bodyHtml;
      }
    }
    if (/^\d+$/.test(String(openId || ''))) showForm(Number(openId));
    else showList();
    return host;
  }

  // ── 列表↔編輯／新增 網址同步：讓瀏覽器「上一頁」能回到列表 ──────────
  // enterDetail(key, id)：從列表點「編輯」／「＋新增」時呼叫（id 為 null 代表新增）。
  //   用 pushState（不是改 location.hash）把網址推成 #key/<id 或 new>：會建立一筆瀏覽器
  //   歷史紀錄，但不觸發 hashchange（不會害整個模組重新掛載），實際換畫面仍由既有的
  //   showForm() 直接處理，跟現在一樣是立即、不重新抓資料的記憶體內切換。
  // leaveDetail(key)：「返回列表」／「取消」／存檔成功時呼叫。若目前網址正是 enterDetail
  //   推上去的 #key/<id 或 new>（不管是剛剛用 enterDetail 推的、還是深連結／整頁重新整理
  //   直接落在這個網址），收回 #key（觸發 hashchange 重新渲染列表，正好順便反映剛剛的異動）
  //   並回傳 true；呼叫端若收到 false（網址不是預期樣子，理論上不會發生）要自行改叫 showList()。
  //   收網址一律用「賦值」而非 history.back()：不管使用者是從列表點進來、還是深連結／整頁
  //   重新整理直接落在編輯頁，行為一致、不必分兩套邏輯判斷從哪裡進來的。
  function enterDetail(key, id) {
    const t = '#' + key + '/' + (id == null ? 'new' : id);
    if (location.hash !== t) history.pushState(null, '', t);
  }
  function leaveDetail(key) {
    const re = new RegExp('^#/?' + key + '/(\\d+|new)$');
    if (!re.test(location.hash)) return false;
    location.hash = '#' + key;
    return true;
  }
  // 新增存檔成功後、原地繼續編輯剛建立那筆（如公告／會員存完馬上接著編）：
  // 用 replaceState 把 #key/new 原地換成 #key/<新id>，不額外多推一筆歷史紀錄
  // （否則上一頁會先跳回「新增」這個已經沒意義的空表單，要按兩次才回得了列表）。
  function resolveDetail(key, id) {
    history.replaceState(null, '', '#' + key + '/' + id);
  }

  // ── boot ─────────────────────────────────────────────────
  // 後台 hash 路由（模組層級）：網址反映目前模組，支援瀏覽器上一頁/下一頁
  function goAdmin(k) {
    const t = '#' + k;
    if (location.hash === t) applyHash();
    else location.hash = t;
  }
  function applyHash() {
    if (!me) return;
    // 支援 #模組/參數 的深連結（目前用於 #announcements/<id> 直接開該則公告的編輯頁）
    const [k, arg] = (location.hash.replace(/^#\/?/, '') || 'announcements').split('/');
    if (k === 'change-password') return showChangePassword();
    showModule(MODULES.some(([mk]) => mk === k) ? k : 'announcements', arg);
  }
  async function start() {
    await fetchEnv();
    try { me = (await api('/me')).user; authed = true; applyHash(); }
    catch { authed = false; loginView(); }
  }
  window.addEventListener('hashchange', applyHash);
  // 任何渲染後自動處理表格（卡片化／捲動提示），並在縮放時更新提示
  let enhRaf = 0;
  new MutationObserver(() => { if (enhRaf) return; enhRaf = requestAnimationFrame(() => { enhRaf = 0; enhanceTables(); }); }).observe(app, { childList: true, subtree: true });
  window.addEventListener('resize', () => app.querySelectorAll('.pa-tablewrap').forEach(applyShadow));
  start();
})();
