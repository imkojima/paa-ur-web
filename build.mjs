// 前端 build：web/（原始碼）→ dist/（部署產物）
//   --mode prod  minify + 內容雜湊檔名 + 改寫 HTML 引用 + 產生 _headers（長快取）
//   --mode dev   純複製（不 minify/不 hash，可直接除錯）
//   --watch      監看 web/ 變更自動重建（dev 用）
// web/ 始終是可編輯原始碼；dist/ 為產物（git 忽略）。
import * as esbuild from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, 'web');
const DIST = join(__dirname, 'dist');
const argv = process.argv.slice(2);
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'prod';
const WATCH = argv.includes('--watch');
const PROD = MODE === 'prod';

// 需 minify/雜湊的進入點；其餘（HTML、圖片、tinymce…）原樣複製
const ENTRIES = [
  { src: 'assets/app.js', out: 'assets' },
  { src: 'assets/styles.css', out: 'assets' },
  { src: 'admin/admin.js', out: 'admin' },
  { src: 'admin/admin.css', out: 'admin' },
];
const ENTRY_SET = new Set(ENTRIES.map((e) => e.src));
const rel = (p) => relative(DIST, p).split('\\').join('/');

async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  // 複製整個 web/，排除 build 進入點（由 esbuild 產出）
  await cp(WEB, DIST, {
    recursive: true,
    filter: (s) => !ENTRY_SET.has(relative(WEB, s).split('\\').join('/')),
  });

  const manifest = {}; // 'assets/app.js' -> 'assets/app-HASH.js'
  for (const e of ENTRIES) {
    const r = await esbuild.build({
      entryPoints: [join(WEB, e.src)],
      outdir: join(DIST, e.out),
      entryNames: PROD ? '[name]-[hash]' : '[name]',
      minify: PROD,
      bundle: false,
      metafile: true,
      legalComments: 'none',
      logLevel: 'error',
    });
    manifest[e.src] = rel(join(__dirname, Object.keys(r.metafile.outputs)[0]));
  }

  if (PROD) {
    await rewriteHtml(manifest);
    await writeHeaders(manifest);
  }
  console.error(`[build] mode=${MODE} → dist/ ready`);
  return manifest;
}

async function rewriteHtml(m) {
  const idx = join(DIST, 'index.html');
  let html = await readFile(idx, 'utf8');
  html = html.replace('/assets/app.js', '/' + m['assets/app.js'])
    .replace('/assets/styles.css', '/' + m['assets/styles.css']);
  await writeFile(idx, html);

  const adm = join(DIST, 'admin', 'index.html');
  let a = await readFile(adm, 'utf8');
  a = a.replace('href="admin.css"', 'href="' + m['admin/admin.css'].replace('admin/', '') + '"')
    .replace('src="admin.js"', 'src="' + m['admin/admin.js'].replace('admin/', '') + '"');
  await writeFile(adm, a);
}

async function writeHeaders(m) {
  // 全站安全性標頭（靜態資產；Worker 回應另由 index.ts middleware 設定）
  // CSP（Report-Only）需與 api/src/index.ts 的 CSP 常數保持一致
  const csp = "default-src 'self'; base-uri 'self'; object-src 'none'; "
    + "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    + "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; "
    + "connect-src 'self' https://cloudflareinsights.com; frame-src 'self' blob: https://challenges.cloudflare.com https://www.openstreetmap.org; worker-src 'self' blob:; "
    + "frame-ancestors 'self'; form-action 'self'; report-uri /api/csp-report";
  const lines = [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: SAMEORIGIN',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: geolocation=(), microphone=(), camera=()',
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '  Content-Security-Policy-Report-Only: ' + csp,
    '',
    '# 內容雜湊檔：長快取 immutable（檔名改變才更新）',
  ];
  for (const k of Object.keys(m)) {
    lines.push('/' + m[k], '  Cache-Control: public, max-age=31536000, immutable');
  }
  lines.push(''); // 其餘（index.html、圖片等）沿用 Workers Assets 預設 must-revalidate
  await writeFile(join(DIST, '_headers'), lines.join('\n'));
}

await build();

if (WATCH) {
  const { watch } = await import('node:fs');
  let t;
  watch(WEB, { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => build().catch((e) => console.error('[build] error:', e.message)), 150);
  });
  console.error('[build] watching web/ … (Ctrl-C 結束)');
}
