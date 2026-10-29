// 從 seeds/demo-data.js 產生 dev seed SQL（demo 內容）。
// 用法：node scripts/gen-seed.mjs > seeds/0001_content.sql
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dirname, '..', 'seeds', 'demo-data.js');

// 載入 demo-data.js：提供 window，eval 後從 window 取出 DEMO_*
const window = {};
// eslint-disable-next-line no-eval
eval(readFileSync(dataPath, 'utf8'));

// ── helpers ──────────────────────────────────────────────
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const j = (o) => (o === null || o === undefined ? 'NULL' : q(JSON.stringify(o)));
const rocDate = (d) => { // '115.05.28' -> '2026-05-28'
  if (!d) return 'NULL';
  const p = String(d).split('.');
  if (p.length !== 3) return 'NULL';
  return `'${+p[0] + 1911}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}'`;
};
const bytes = (s) => { // '420 KB' / '1.1 MB' -> integer bytes
  if (!s) return 'NULL';
  const m = /([\d.]+)\s*(KB|MB|GB|B)?/i.exec(String(s));
  if (!m) return 'NULL';
  const n = parseFloat(m[1]); const u = (m[2] || 'B').toUpperCase();
  const mul = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[u];
  return String(Math.round(n * mul));
};
const ftype = (t) => (['pdf', 'doc', 'xls', 'img'].includes(t) ? t : 'other');
const out = [];
const w = (s) => out.push(s);

w('-- DEV demo 內容（由 api/seeds/demo-data.js 產生；勿手動編輯，改 gen-seed.mjs）');
w('-- 插入順序已符合外鍵相依（父表先、子表後、查表用子查詢）。公告分類與法律頁面列由 migration 建立。');

// ── 公告＋附件 ─────────────────────────────────────────────
let aid = 0;
const catSub = (name) => `(SELECT id FROM announcement_categories WHERE name=${q(name)} AND scope='public')`;
window.DEMO_NEWS.forEach((n) => {
  aid += 1;
  w(`INSERT INTO announcements (id,visibility,category_id,title,excerpt,body,publish_date,views,is_pinned,show_in_list,status,published_at) VALUES (`
    + `${aid},'public',${catSub(n.cat)},${q(n.title)},${q(n.excerpt)},${j(n.body || null)},${rocDate(n.date)},`
    + `${n.views || 0},${n.pinned ? 1 : 0},1,'published',${rocDate(n.date)});`);
  (n.files || []).forEach((f, i) => {
    w(`INSERT INTO attachments (owner_type,owner_id,name,file_path,size_bytes,type,sort_order) VALUES `
      + `('announcement',${aid},${q(f.name)},${q('seed/' + f.name)},${bytes(f.size)},'${ftype(f.type)}',${i});`);
  });
});

// ── 檔案下載（document_categories + documents）────────────────
const docCats = [...new Set(window.DEMO_DOWNLOADS.map((d) => d.cat))];
docCats.forEach((c, i) => w(`INSERT INTO document_categories (name,access_scope,sort_order) VALUES (${q(c)},'public',${i});`));
const docCatSub = (name) => `(SELECT id FROM document_categories WHERE name=${q(name)})`;
window.DEMO_DOWNLOADS.forEach((d, i) => {
  w(`INSERT INTO documents (name,description,publish_date,category_id,access,file_path,size_bytes,type,is_active,sort_order) VALUES (`
    + `${q(d.name)},NULL,NULL,${docCatSub(d.cat)},'public',NULL,${bytes(d.size)},'${ftype(d.type)}',1,${i});`);
});

// ── 相關連結 ───────────────────────────────────────────────
window.DEMO_FRIENDS.forEach((f, i) => {
  w(`INSERT INTO friend_links (name,url,is_active,sort_order) VALUES (${q(f.name)},${f.url ? q(f.url) : 'NULL'},1,${i});`);
});

// ── 首頁輪播 ───────────────────────────────────────────────
window.DEMO_HERO.forEach((h, i) => {
  const btns = (h.buttons || []).map((b) => ({ label: b.label, target_page: b.page, target_arg: b.arg || null, is_primary: !!b.primary }));
  w(`INSERT INTO hero_slides (background_image,eyebrow,title,description,buttons,is_active,sort_order) VALUES (`
    + `${h.bg ? q(h.bg) : 'NULL'},${q(h.eyebrow)},${q(h.title)},${h.desc ? q(h.desc) : 'NULL'},${j(btns)},1,${i});`);
});

// ── 法律頁面（列已由 migration 建立，這裡只填示範內文）────────────
for (const [key, doc] of Object.entries(window.DEMO_LEGAL)) {
  w(`UPDATE legal_pages SET blocks=${j(doc.blocks || [])} WHERE "key"=${q(key)};`);
}

process.stdout.write(out.join('\n') + '\n');
