// Cloudflare Workers 平台相依的**唯一**集中處。
//
// 後端其餘部分存取平台資源一律經由 `c.env.*`（DB / KV / FILES / ASSETS）——那是 Hono 注入的物件，
// 換 runtime 時只要綁上介面相容的 shim，那 180 餘處呼叫端一行都不用改。
// 真正綁死 Workers、無法用 shim 承接的是「全域 API」，全部在本檔：
//
//   background()  → executionCtx.waitUntil
//   edgeCache     → caches.default
//   clientIp()    → CF-Connecting-IP 標頭
//
// 搬離 Cloudflare 時，改寫本檔即可（見 docs/雲端遷移可行性評估.md §5「痛點二」）。
import type { Context } from 'hono';

/**
 * 背景工作（不阻塞回應）。
 *
 * Workers 必須用 `executionCtx.waitUntil` 登記，否則回應送出後 Worker 可能在 promise
 * 完成前就被回收，工作靜默消失。其他 runtime（Node / Cloud Run）沒有這個限制，
 * 屆時改為 fire-and-forget（`void work.catch(...)`）即可。
 *
 * 一律吞掉錯誤：呼叫端都是 best-effort 的次要更新（瀏覽數、最後登入時間、寫快取），
 * 失敗不該影響已經送出的回應。
 */
export function background(c: Context, work: Promise<unknown>): void {
  c.executionCtx.waitUntil(work.catch(() => { /* best-effort：次要工作失敗不影響主流程 */ }));
}

/**
 * 邊緣快取（公開 GET 回應）。
 *
 * Workers 提供全域 `caches.default`。其他 runtime 沒有對應物——搬遷時刪除本物件與
 * index.ts 的快取中介層，改由前置的 CDN／Nginx 依 `Cache-Control` 標頭快取即可。
 */
export const edgeCache = {
  match: (req: Request): Promise<Response | undefined> => caches.default.match(req),
  put: (req: Request, res: Response): Promise<void> => caches.default.put(req, res),
};

/**
 * 用戶端 IP（速率限制、稽核紀錄用）。
 *
 * Cloudflare 以 `CF-Connecting-IP` 傳遞真實來源 IP，且此標頭由邊緣覆寫，用戶端無法偽造。
 * 其他平台改讀 `X-Forwarded-For`（但需注意：該標頭可被偽造，必須只信任最外層反向代理附加的值）。
 */
export const clientIp = (c: Context): string => c.req.header('CF-Connecting-IP') || 'unknown';
