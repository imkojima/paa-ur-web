#!/usr/bin/env node
// 備份：D1 全量 SQL dump ＋ R2 檔案鏡像。
//
// 為何需要：D1 的 Time Travel 只是「平台內」的時間點還原，且不涵蓋 R2；
// R2 中的附件／輪播背景／下載檔目前是唯一副本。本腳本把兩者都取出到 Cloudflare 之外。
//
// 用法：
//   npm run backup:prod              # api/ 下執行
//   node scripts/backup.mjs --env prod [--out <dir>] [--keep 30] [--skip-r2]
//
// 前置需求見 docs/備份與還原手冊.md（rclone ＋ R2 唯讀 API token）。
// 每次備份結束都會自動跑一次還原驗證——未經驗證的備份不算備份。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBackup } from './verify-backup.mjs';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── JSONC → JSON（wrangler.jsonc 有註解；資源名稱以它為單一事實來源，避免與腳本各寫一份而漂移）
function parseJsonc(src) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (c === '}' || c === ']') { out = out.replace(/,\s*$/, ''); } // 去除尾逗號
    out += c;
  }
  return JSON.parse(out);
}

function loadResources(envName) {
  const cfg = parseJsonc(readFileSync(join(API_DIR, 'wrangler.jsonc'), 'utf8'));
  const e = cfg.env?.[envName];
  if (!e) throw new Error(`wrangler.jsonc 沒有 env.${envName}`);
  const db = e.d1_databases?.[0]?.database_name;
  const bucket = e.r2_buckets?.[0]?.bucket_name;
  if (!db || !bucket) throw new Error(`env.${envName} 缺少 D1 或 R2 設定`);
  return { db, bucket, accountId: cfg.account_id };
}

// ── CLI ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const ENV = flag('env');
if (!ENV || !['dev', 'prod'].includes(ENV)) {
  console.error('用法：node scripts/backup.mjs --env <dev|prod> [--out <dir>] [--keep 30] [--skip-r2]');
  process.exit(2);
}
const KEEP = Number(flag('keep', '30'));
const SKIP_R2 = has('skip-r2');
const { db: DB_NAME, bucket: BUCKET, accountId } = loadResources(ENV);

// 預設輸出到 repo 外的上層目錄，避免備份（含個資）被誤 commit。
const OUT_ROOT = resolve(flag('out', join(API_DIR, '..', '..', 'paa-ur-backup')));
const ENV_DIR = join(OUT_ROOT, ENV);
const D1_DIR = join(ENV_DIR, 'd1');
const R2_CURRENT = join(ENV_DIR, 'r2', 'current');
const R2_ARCHIVE = join(ENV_DIR, 'r2', 'archive');

// UTC 時戳，可直接排序（檔名不含冒號，跨平台安全）
const STAMP = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z');

const log = (m) => console.log(m);
const fail = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };

// ── 前置檢查：先全部檢查完再動手，不要做到一半才失敗 ─────────
function preflight() {
  log('▸ 前置檢查');

  const w = spawnSync('npx', ['wrangler', 'whoami'], { cwd: API_DIR, encoding: 'utf8' });
  if (w.status !== 0) fail('wrangler 未登入或不可用。請先執行：npx wrangler login');
  log('  ✓ wrangler 已登入');

  if (SKIP_R2) {
    log('  ⚠ 已指定 --skip-r2：本次不備份 R2 檔案（附件／輪播背景／下載檔）');
    return;
  }

  const r = spawnSync('rclone', ['version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail('找不到 rclone（R2 備份必需）。\n' +
      '  安裝：brew install rclone\n' +
      '  或先只備份資料庫：node scripts/backup.mjs --env ' + ENV + ' --skip-r2\n' +
      '  （但 R2 內的附件／輪播背景／下載檔目前是唯一副本，長期不備份風險極高）');
  }
  log(`  ✓ rclone ${r.stdout.split('\n')[0].replace('rclone ', '')}`);

  const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    fail(`缺少環境變數：${missing.join(', ')}\n` +
      '  請在 Cloudflare 後台建立 R2 唯讀 API token，並設定：\n' +
      '    export R2_ACCESS_KEY_ID="..."\n' +
      '    export R2_SECRET_ACCESS_KEY="..."\n' +
      '  詳見 docs/備份與還原手冊.md');
  }
  log('  ✓ R2 憑證已設定');
}

// ── D1：全量 SQL dump ─────────────────────────────────────────
function exportD1() {
  log(`\n▸ 匯出 D1（${DB_NAME}）`);
  mkdirSync(D1_DIR, { recursive: true });
  const out = join(D1_DIR, `${DB_NAME}-${STAMP}.sql`);

  const r = spawnSync('npx', [
    'wrangler', 'd1', 'export', DB_NAME,
    '--remote', '--env', ENV, '--output', out, '--skip-confirmation',
  ], { cwd: API_DIR, encoding: 'utf8' });

  if (r.status !== 0) fail(`D1 匯出失敗：\n${r.stderr || r.stdout}`);
  if (!existsSync(out) || statSync(out).size === 0) fail('D1 匯出檔為空');

  const size = statSync(out).size;
  log(`  ✓ ${out.replace(OUT_ROOT, '<backup>')}（${(size / 1024).toFixed(0)} KB）`);
  return out;
}

// ── R2：鏡像同步 ──────────────────────────────────────────────
// sync（非 copy）以反映刪除，但用 --backup-dir 把被刪／被覆寫的舊檔移入 archive/<時戳>/，
// 因此「來源誤刪」不會讓備份跟著失去該檔——這正是備份要防的情境。
function syncR2() {
  if (SKIP_R2) return null;
  log(`\n▸ 同步 R2（${BUCKET}）`);
  mkdirSync(R2_CURRENT, { recursive: true });

  const r = spawnSync('rclone', [
    'sync', `R2:${BUCKET}`, R2_CURRENT,
    '--backup-dir', join(R2_ARCHIVE, STAMP),
    '--transfers', '8',
    '--stats-one-line', '--stats', '5s',
    '--progress',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      // 以環境變數設定 remote，免去 rclone config 檔（CI 可直接用）
      RCLONE_CONFIG: '/dev/null', // 明確表示不用設定檔，免去 "config file not found" 的 NOTICE
      RCLONE_CONFIG_R2_TYPE: 's3',
      RCLONE_CONFIG_R2_PROVIDER: 'Cloudflare',
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      RCLONE_CONFIG_R2_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com`,
      RCLONE_CONFIG_R2_ACL: 'private',
      RCLONE_CONFIG_R2_NO_CHECK_BUCKET: 'true',
    },
  });

  if (r.status !== 0) fail('rclone 同步失敗（見上方訊息）');

  const count = countFiles(R2_CURRENT);
  log(`  ✓ ${count} 個檔案 → ${R2_CURRENT.replace(OUT_ROOT, '<backup>')}`);
  return count;
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

// ── 保留策略：只留最近 N 份 dump（R2 鏡像為增量，不在此列） ───
function prune() {
  const dumps = readdirSync(D1_DIR).filter((f) => f.endsWith('.sql')).sort();
  const drop = dumps.slice(0, Math.max(0, dumps.length - KEEP));
  for (const f of drop) rmSync(join(D1_DIR, f));
  if (drop.length) log(`\n▸ 清理：移除 ${drop.length} 份逾期 dump（保留最近 ${KEEP} 份）`);
}

// ── 主流程 ────────────────────────────────────────────────────
log(`PAA 備份 — env=${ENV}  時間=${STAMP}\n輸出=${OUT_ROOT}\n`);

preflight();
const dumpPath = exportD1();
const fileCount = syncR2();

// 驗證：實際把 dump 還原進 SQLite，並比對 D1 引用的檔案是否都在鏡像中。
log('\n▸ 驗證備份（實際還原）');
const report = verifyBackup({
  dumpPath,
  r2Dir: SKIP_R2 ? null : R2_CURRENT,
  archiveDir: SKIP_R2 ? null : R2_ARCHIVE,
});
for (const line of report.lines) log(`  ${line}`);

const manifest = {
  env: ENV,
  stamp: STAMP,
  createdAt: new Date().toISOString(),
  d1: { database: DB_NAME, dump: dumpPath, tables: report.tables, rows: report.totalRows },
  r2: SKIP_R2 ? { skipped: true } : { bucket: BUCKET, files: fileCount, mirror: R2_CURRENT, archive: R2_ARCHIVE },
  verified: report.ok,
  issues: report.issues,
  warnings: report.warnings,
};
mkdirSync(ENV_DIR, { recursive: true });
writeFileSync(join(ENV_DIR, `manifest-${STAMP}.json`), JSON.stringify(manifest, null, 2));
writeFileSync(join(ENV_DIR, 'latest.json'), JSON.stringify(manifest, null, 2));

prune();

if (!report.ok) {
  console.error('\n✗ 備份已產出，但驗證未通過——請處理上列問題後再信任這份備份。');
  process.exit(1);
}
log(`\n✓ 備份完成並通過驗證：${ENV_DIR}`);
if (report.warnings.length) {
  // 資料本身的問題，不代表備份有問題——不影響離開碼，排程不會被誤判為失敗。
  log('\n⚠ 另有資料品質問題（不影響備份可還原性）：');
  for (const w of report.warnings) log(`  - ${w}`);
}
log('\n  提醒：請確認此目錄有異地副本（外接硬碟／雲端硬碟），勿只存在本機。');
