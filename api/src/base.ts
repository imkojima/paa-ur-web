// 本站的網址前綴（base path）。
//
// 正式站掛在澎湖縣建築師公會網站底下：https://www.paa.org.tw/expand-life/
// （www.paa.org.tw 本身是 paa-web 的 Worker；本 Worker 以 Route `www.paa.org.tw/expand-life*`
// 疊在它前面，見 wrangler.jsonc）。dev、本機也用同一個前綴，測到的就是上線的樣子。
//
// 前綴改動時需同步：build.mjs 的 BASE、web/index.html 的路徑、web/assets/app.js 與
// web/admin/admin.js 的 BASE、wrangler.jsonc 的 routes、paa-web 的 robots.txt。
//
// 資料庫內容一律存「站內根相對」路徑（/files/…、/subsidy），不含前綴；
// 由前台、後台、meta.ts 在輸出時補上前綴。
export const BASE = '/expand-life';

/** 站內根相對路徑（/files/x、/subsidy）補上前綴；外部網址、已含前綴者、相對路徑原樣返回。 */
export function withBase(u: string): string {
  if (!u || !u.startsWith('/') || u.startsWith('//')) return u;
  if (u === BASE || u.startsWith(BASE + '/')) return u;
  return BASE + u;
}
