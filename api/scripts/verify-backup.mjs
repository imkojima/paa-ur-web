#!/usr/bin/env node
// 還原演練：把 D1 dump 真的還原進一個 SQLite 資料庫，並比對 R2 鏡像的完整性。
//
// 「未經驗證的備份不算備份」——本腳本不是檢查檔案存不存在，而是實際執行還原：
// dump 若語法損毀、被截斷、或缺表，載入就會失敗。
// 還原目標是記憶體中的暫時 DB，對線上環境完全無副作用。
//
// 用法：
//   npm run backup:verify:prod                       # 驗證最近一次備份
//   node scripts/verify-backup.mjs --env prod
//   node scripts/verify-backup.mjs --dump <path.sql> [--r2 <mirror-dir>]

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// D1 中存放 R2 key 的所有欄位。新增這類欄位時務必同步更新，否則新檔案不會被納入驗證。
const R2_REF_COLUMNS = [
  ['attachments', 'file_path'],
  ['documents', 'file_path'],
  ['hero_slides', 'background_image'],
];

// D1 中的路徑欄位混用三種慣例，必須分辨清楚，否則會把不屬於 R2 的東西誤判為「備份缺檔」：
//
//   /files/hero/abc-x.jpg         → R2 物件，帶 /files/ 前綴（hero_slides.background_image）
//   attachments/abc-x.pdf         → R2 物件，裸 key（/upload 回傳的 key 直接入庫）
//   assets/hero/01.jpg            → **前端靜態檔**（web/assets/，隨 dist/ 出貨、由 ASSETS binding 服務）
//                                   ——不在 R2，由 git 版控，不需要也不可能出現在 R2 鏡像中
//
// 判別方式不靠前綴猜測，而是直接看該路徑在 web/ 底下有沒有實體檔案——這對三種慣例都成立，
// 且日後新增前端資源目錄也不會失準。
const WEB_DIR = resolve(API_DIR, '..', 'web');
const isWebAsset = (p) => {
  const rel = String(p || '').replace(/^\//, '');
  return rel !== '' && existsSync(join(WEB_DIR, rel));
};

// R2 key：去掉 /files/ 前綴（見 admin.ts 的 fileKey）；裸 key 則原樣。
const toKey = (p) => String(p || '').replace(/^\/files\//, '');

function listKeys(dir, prefix = '') {
  const out = new Set();
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) for (const k of listKeys(join(dir, e.name), rel)) out.add(k);
    else out.add(rel);
  }
  return out;
}

// archive/ 下是一層 <時戳>/ 子目錄，其內才是原始的 R2 key 結構。
// 必須逐個時戳目錄展開後聯集，否則 key 會多出時戳前綴而永遠對不上 D1 的引用。
function listArchiveKeys(archiveDir) {
  const out = new Set();
  if (!archiveDir || !existsSync(archiveDir)) return out;
  for (const e of readdirSync(archiveDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    for (const k of listKeys(join(archiveDir, e.name))) out.add(k);
  }
  return out;
}

/**
 * 還原 dump 並驗證。
 *
 * issues（致命，離開碼 1）＝「這份備份不可信」：dump 載不進去、migration 落後、關鍵表全空。
 * warnings（非致命，離開碼 0）＝「備份是好的，但資料本身有問題」：例如 D1 指向不存在的檔案。
 * 兩者刻意分開——若讓資料品質問題使備份失敗，備份就會永遠亮紅燈，紅燈久了就沒人看。
 *
 * @param {{dumpPath: string, r2Dir: string|null, archiveDir?: string|null}} opts
 * @returns {{ok: boolean, lines: string[], issues: string[], warnings: string[], tables: number, totalRows: number}}
 */
export function verifyBackup({ dumpPath, r2Dir, archiveDir = null }) {
  const lines = [];
  const issues = [];
  const warnings = [];

  if (!existsSync(dumpPath)) {
    return { ok: false, lines: [`✗ 找不到 dump：${dumpPath}`], issues: ['dump 不存在'], warnings, tables: 0, totalRows: 0 };
  }

  // ── 1. 真正的還原：把 dump 灌進 SQLite。損毀／截斷的 dump 會在此爆炸。
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(dumpPath, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      lines: [`✗ 還原失敗——dump 無法載入 SQLite：${e.message}`],
      issues: [`dump 損毀：${e.message}`], warnings, tables: 0, totalRows: 0,
    };
  }

  const tables = db.prepare(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
  ).all().map((r) => r.name);

  let totalRows = 0;
  const counts = {};
  for (const t of tables) {
    const n = db.prepare(`select count(*) as c from "${t}"`).get().c;
    counts[t] = n;
    totalRows += n;
  }
  lines.push(`✓ 還原成功：${tables.length} 張表、${totalRows.toLocaleString()} 列`);

  // ── 2. migration 完整性：dump 內的 d1_migrations 應涵蓋 migrations/ 下所有檔案。
  //     少了代表 dump 來自尚未套用 migration 的舊資料庫。
  const onDisk = readdirSync(join(API_DIR, 'migrations')).filter((f) => f.endsWith('.sql')).length;
  const applied = counts.d1_migrations ?? 0;
  if (applied < onDisk) {
    issues.push(`migration 落後：dump 內僅 ${applied} 筆，但 migrations/ 有 ${onDisk} 個檔案`);
    lines.push(`✗ migration：dump ${applied} 筆 < 本地 ${onDisk} 個檔案`);
  } else {
    lines.push(`✓ migration：${applied} 筆，與 migrations/ 一致`);
  }

  // ── 3. 關鍵表不應為空。全空多半代表匯出到了錯的（或空的）資料庫。
  for (const t of ['admin_users']) {
    if (tables.includes(t) && counts[t] === 0) {
      issues.push(`關鍵表 ${t} 為空`);
      lines.push(`✗ ${t} 為空——是否匯出了錯誤的資料庫？`);
    }
  }

  // ── 4. R2 交叉比對。
  //
  //  備份本身的正確性由 rclone sync 保證：R2 有的，鏡像就有。
  //  這裡多做一層 D1 ↔ R2 的參照完整性檢查，三種結果的意義完全不同：
  //
  //    在 current/ ──── 正常。
  //    在 archive/ ──── 檔案已從 R2 刪除，但備份仍留有副本。備份正在發揮作用，僅需知會。
  //    兩者皆無 ─────── 「懸空引用」：D1 指向一個 R2 從來沒有的檔案。
  //                     這是 **D1 的資料品質問題**，不是備份缺陷——鏡像不可能備份到不存在的東西。
  //                     故列為 warning 而非 issue：若讓它使備份失敗，備份就永遠亮紅燈。
  //                     （本專案的 seed 內容即含此類引用，見 seeds/0001_content.sql）
  if (r2Dir) {
    const referenced = new Set();
    const webAssets = new Set();
    for (const [table, col] of R2_REF_COLUMNS) {
      if (!tables.includes(table)) continue;
      const cols = db.prepare(`pragma table_info("${table}")`).all().map((c) => c.name);
      if (!cols.includes(col)) continue;
      for (const row of db.prepare(`select "${col}" as v from "${table}" where "${col}" is not null and "${col}" <> ''`).all()) {
        if (/^https?:\/\//i.test(row.v)) continue;   // 外部 URL
        if (isWebAsset(row.v)) { webAssets.add(row.v); continue; } // 前端靜態檔，由 git 版控
        referenced.add(toKey(row.v));
      }
    }
    if (webAssets.size) lines.push(`ℹ R2：另有 ${webAssets.size} 個引用指向前端靜態檔（web/assets/，由 git 版控，不需 R2 備份）`);

    const mirrored = listKeys(r2Dir);
    const archived = listArchiveKeys(archiveDir);
    const missing = [...referenced].filter((k) => !mirrored.has(k));
    const rescued = missing.filter((k) => archived.has(k));   // 線上已刪，但備份留有副本
    const dangling = missing.filter((k) => !archived.has(k)); // 從未存在於 R2
    const orphans = [...mirrored].filter((k) => !referenced.has(k));

    lines.push(`✓ R2：鏡像 ${mirrored.size} 個檔案；D1 引用 ${referenced.size} 個，其中 ${referenced.size - missing.length} 個在鏡像中`);

    if (rescued.length) {
      lines.push(`ℹ R2：${rescued.length} 個被引用的檔案已從線上刪除，但備份保有副本（archive/）——備份正在發揮作用`);
    }
    if (dangling.length) {
      warnings.push(`D1 有 ${dangling.length} 筆懸空引用（指向 R2 中不存在的檔案；非備份問題，但前台這些連結會 404）`);
      lines.push(`⚠ R2：${dangling.length} 筆懸空引用——D1 指向 R2 從未有過的檔案`);
      for (const k of dangling.slice(0, 3)) lines.push(`    ${k}`);
      if (dangling.length > 3) lines.push(`    …另有 ${dangling.length - 3} 筆`);
    }
    if (orphans.length) lines.push(`ℹ R2：另有 ${orphans.length} 個未被引用的檔案（孤兒，不影響還原）`);
  } else {
    lines.push('⚠ 未比對 R2（本次未備份檔案）');
  }

  db.close();
  return { ok: issues.length === 0, lines, issues, warnings, tables: tables.length, totalRows };
}

// ── CLI ───────────────────────────────────────────────────────
function latestDump(env) {
  const root = resolve(join(API_DIR, '..', '..', 'paa-ur-backup', env));
  const archive = join(root, 'r2', 'archive');
  const archiveDir = existsSync(archive) ? archive : null;

  const latest = join(root, 'latest.json');
  if (existsSync(latest)) {
    const m = JSON.parse(readFileSync(latest, 'utf8'));
    if (m.d1?.dump && existsSync(m.d1.dump)) return { dumpPath: m.d1.dump, r2Dir: m.r2?.mirror ?? null, archiveDir };
  }
  const d1Dir = join(root, 'd1');
  if (!existsSync(d1Dir)) return null;
  const dumps = readdirSync(d1Dir).filter((f) => f.endsWith('.sql')).sort();
  if (!dumps.length) return null;
  const r2 = join(root, 'r2', 'current');
  return { dumpPath: join(d1Dir, dumps.at(-1)), r2Dir: existsSync(r2) ? r2 : null, archiveDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

  let target;
  const dump = flag('dump');
  if (dump) {
    target = {
      dumpPath: resolve(dump),
      r2Dir: flag('r2') ? resolve(flag('r2')) : null,
      archiveDir: flag('archive') ? resolve(flag('archive')) : null,
    };
  } else {
    const env = flag('env');
    if (!env) {
      console.error('用法：node scripts/verify-backup.mjs --env <dev|prod>\n' +
        '　　　node scripts/verify-backup.mjs --dump <path.sql> [--r2 <mirror-dir>]');
      process.exit(2);
    }
    target = latestDump(env);
    if (!target) { console.error(`✗ 找不到 ${env} 的備份，請先執行：npm run backup:${env}`); process.exit(1); }
  }

  const age = ((Date.now() - statSync(target.dumpPath).mtimeMs) / 86400000).toFixed(1);
  console.log(`還原演練 — ${target.dumpPath}\n備份時間：${age} 天前\n`);

  const report = verifyBackup(target);
  for (const l of report.lines) console.log(`  ${l}`);

  if (!report.ok) { console.error('\n✗ 驗證未通過——這份備份不可信：\n  - ' + report.issues.join('\n  - ')); process.exit(1); }

  console.log('\n✓ 驗證通過——這份備份可以還原。');
  if (report.warnings.length) {
    // 非致命：備份是好的，但資料本身有問題。不影響離開碼，避免排程被誤判為失敗。
    console.log('\n⚠ 另有資料品質問題（不影響備份可還原性）：\n  - ' + report.warnings.join('\n  - '));
  }
}
