// 認證：PBKDF2 密碼雜湊 + KV session + cookie 工具（後台管理者）。
// 同一套 PBKDF2 參數也用於 scripts/hash-password.mjs（建立管理者帳號）。
import type { Context } from 'hono';

const enc = new TextEncoder();
const PBKDF2_ITER = 100000;
const nowSec = () => Math.floor(Date.now() / 1000);

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (str: string) => {
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
};

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(pw, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(h)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    const [scheme, itStr, saltB, hashB] = stored.split('$');
    if (scheme !== 'pbkdf2') return false;
    const got = await pbkdf2(pw, unb64(saltB), Number(itStr));
    const expected = unb64(hashB);
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

function randToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function getCookie(c: Context, name: string): string | null {
  const m = (c.req.header('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// ── 伺服器端 session（KV）─────────────────────────────────────
//
// session 規則：滑動續期（idle TTL）＋絕對上限（abs）＋撤銷（token_version），前綴、壽命與 cookie 設定以參數傳入。
// 這些是**安全關鍵**規則：絕對上限若失效，session 就能靠滑動續期無限延壽。日後若再加一種登入身分，
// 以同一個 createSessionStore() 建立新實例，不要另寫一份。
//
// `tv`（token_version）用於即時撤銷：改密碼／停權時 DB 端 +1，回查不符即失效。
export type SessionBase = { tv?: number; exp?: number; abs?: number };

export type SessionStore<T extends SessionBase> = {
  create(kv: KVNamespace, data: T): Promise<string>;
  get(kv: KVNamespace, token: string | null): Promise<T | null>;
  /** 滑動續期；回傳 true 表示已續期（呼叫端應重發 cookie）。 */
  touch(kv: KVNamespace, token: string, sess: T): Promise<boolean>;
  /** 覆寫當前 session（如自行改密碼後同步新的 tv，避免把自己一併登出）。 */
  rewrite(kv: KVNamespace, token: string, sess: T): Promise<void>;
  destroy(kv: KVNamespace, token: string | null): Promise<void>;
  readToken(c: Context): string | null;
  setCookie(c: Context, token: string): void;
  clearCookie(c: Context): void;
};

function createSessionStore<T extends SessionBase>(opts: {
  prefix: string; idleTtl: number; absoluteTtl: number;
  cookie: string; sameSite: 'Strict' | 'Lax';
}): SessionStore<T> {
  const { prefix, idleTtl, absoluteTtl, cookie, sameSite } = opts;
  const k = (t: string) => prefix + t;
  // 本次可續的壽命：不得超過絕對上限。<= 0 表示已達上限，session 應死亡。
  const remaining = (sess: T, n: number) => (sess.abs ? Math.min(idleTtl, sess.abs - n) : idleTtl);
  const write = async (kv: KVNamespace, t: string, sess: T, ttl: number) => {
    sess.exp = nowSec() + ttl;
    await kv.put(k(t), JSON.stringify(sess), { expirationTtl: ttl });
  };

  return {
    async create(kv, data) {
      const t = randToken();
      const n = nowSec();
      await kv.put(k(t), JSON.stringify({ ...data, exp: n + idleTtl, abs: n + absoluteTtl }), { expirationTtl: idleTtl });
      return t;
    },
    async get(kv, t) {
      if (!t) return null;
      const v = await kv.get(k(t));
      if (!v) return null;
      const rec = JSON.parse(v) as T;
      // 絕對上限：滑動續期會持續刷新 idle TTL，必須由 abs 封頂，逾時即失效。
      if (rec.abs && nowSec() >= rec.abs) { await kv.delete(k(t)); return null; }
      return rec;
    },
    async touch(kv, t, sess) {
      const n = nowSec();
      // idle 壽命過半才刷新（壓低 KV 寫入）
      if (sess.exp && sess.exp - n >= idleTtl / 2) return false;
      const ttl = remaining(sess, n);
      if (ttl <= 0) return false;
      await write(kv, t, sess, ttl);
      return true;
    },
    async rewrite(kv, t, sess) {
      const n = nowSec();
      const ttl = remaining(sess, n);
      // 已達絕對上限：直接銷毀，不留下一個永遠不會被續期的殭屍 session。
      if (ttl <= 0) { await kv.delete(k(t)); return; }
      await write(kv, t, sess, ttl);
    },
    async destroy(kv, t) {
      if (t) await kv.delete(k(t));
    },
    readToken: (c) => getCookie(c, cookie),
    setCookie: (c, t) => c.header('Set-Cookie',
      `${cookie}=${t}; HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=${idleTtl}`, { append: true }),
    clearCookie: (c) => c.header('Set-Cookie',
      `${cookie}=; HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=0`, { append: true }),
  };
}

// 後台：閒置 60 分＋絕對上限 12 小時。SameSite=Strict（後台無外部連入情境，從嚴）。
export const SESSION_IDLE_TTL = 60 * 60;
export const SESSION_ABSOLUTE_TTL = 60 * 60 * 12;
export type Session = SessionBase & { uid: number; role: string; name: string; username: string };
export const adminSessions = createSessionStore<Session>({
  prefix: 'sess:', idleTtl: SESSION_IDLE_TTL, absoluteTtl: SESSION_ABSOLUTE_TTL,
  cookie: 'paaur_admin', sameSite: 'Strict',
});

// ── 簡易速率限制（KV 計數；防登入爆破／表單灌水）──────────────
export async function rlCheck(kv: KVNamespace, key: string, max: number): Promise<boolean> {
  const v = await kv.get(key);
  return v ? Number(v) >= max : false; // true = 已達上限
}
export async function rlBump(kv: KVNamespace, key: string, windowSec: number): Promise<void> {
  const v = await kv.get(key);
  const n = (v ? Number(v) : 0) + 1;
  await kv.put(key, String(n), { expirationTtl: windowSec });
}
export async function rlReset(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}
// ── 以「帳號」為單位的遞增退避 ────────────────────────────────────
// 上方的 rl* 只看 IP，攻擊者輪換 IP 即可繞過，針對單一帳號的定向爆破幾乎不受限。
// 此處補上以帳號為單位的節流。
//
// 刻意「不」採硬鎖定：硬鎖定會讓任何知道帳號的人都能鎖死指定帳號（防禦淪為 DoS 武器）。
// 改採遞增延遲：前 3 次失敗不罰（容許打錯字），之後逐步拉長間隔，上限 5 分鐘且會自然過期。
// 效果：即便攻擊者有無限 IP，單一帳號也被壓到每小時十餘次；正常使用者幾乎無感。
const BACKOFF_SEC = [0, 0, 0, 0, 5, 15, 60, 180, 300]; // 索引 = 累計失敗次數
const BACKOFF_MAX = 300;
const BACKOFF_TTL = 3600;                              // 1 小時未再失敗即完全歸零

export const acctKey = (prefix: string, account: string): string =>
  prefix + String(account).trim().toLowerCase().slice(0, 128);

/** 回傳此帳號仍需等待的秒數（0 = 可嘗試）。 */
export async function acctWait(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (!raw) return 0;
  try {
    const { next } = JSON.parse(raw) as { next: number };
    const nowSec = Math.floor(Date.now() / 1000);
    return next > nowSec ? next - nowSec : 0;
  } catch { return 0; }
}
/** 記一次失敗，並依累計次數往後推算下一次可嘗試的時間。 */
export async function acctFail(kv: KVNamespace, key: string): Promise<void> {
  const raw = await kv.get(key);
  let n = 0;
  try { n = raw ? (JSON.parse(raw).n as number) || 0 : 0; } catch { n = 0; }
  n += 1;
  const wait = n < BACKOFF_SEC.length ? BACKOFF_SEC[n] : BACKOFF_MAX;
  const nowSec = Math.floor(Date.now() / 1000);
  await kv.put(key, JSON.stringify({ n, next: nowSec + wait }), { expirationTtl: BACKOFF_TTL });
}

// 比較改前／改後的欄位值，只回傳實際有變動的——供資料異動寫入稽核紀錄用
// （'' 與 undefined 視為 null，避免「沒填」跟「填了又清空」被誤判成不同值而灌一堆雜訊）。
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]):
  Record<string, { from: unknown; to: unknown }> {
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    const a = norm(before[k]); const b = norm(after[k]);
    if (a !== b) out[k] = { from: a, to: b };
  }
  return out;
}

// 稽核紀錄（登入等 pre-auth 情境亦可用；admin_user_id 允許 null）。best-effort，不擋主流程。
export async function recordAudit(db: D1Database, e: {
  adminUserId?: number | null; action: string; entityType?: string | null;
  entityId?: string | number | null; ip?: string | null; changes?: unknown;
}): Promise<void> {
  try {
    await db.prepare('insert into audit_logs (admin_user_id,action,entity_type,entity_id,changes,ip) values (?,?,?,?,?,?)')
      .bind(e.adminUserId ?? null, e.action, e.entityType ?? null,
        e.entityId == null ? null : String(e.entityId),
        e.changes ? JSON.stringify(e.changes) : null, e.ip ?? null).run();
  } catch { /* best-effort */ }
}

// 常見弱密碼（小寫比對）；清單保守，僅擋最典型的幾組。
const COMMON_WEAK = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'passw0rd',
  'qwertyui', 'qwerty123', '00000000', '11111111', 'abc12345', 'iloveyou', '87654321',
]);
// 產生強隨機密碼（供管理端核發初始密碼；一次性顯示，不入庫明文）。
// 排除易混淆字元（0/O、1/l/I），以利口頭或紙本交付。
const PW_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword(len = 12): string {
  // 重試直到同時含英文字母與數字（passwordIssue() 的規則）：字母表裡數字只佔 8/56，
  // 12 碼隨機字串約有 16% 機率全落在字母上，若不擋在這裡，「產生隨機密碼」會斷續地
  // 因為系統自己產生的密碼不符規則而失敗。
  let pw: string;
  do {
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    // 以 rejection-free 的取模；字母表長度 55 遠小於 2^32，偏差可忽略。
    pw = Array.from(buf, (n) => PW_ALPHABET[n % PW_ALPHABET.length]).join('');
  } while (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw));
  return pw;
}

// 登入帳號正規化：一律小寫（DB 亦有 COLLATE NOCASE 唯一索引）。
// 不得含 '@'：登入查詢為 `username=? or email=?`，若允許 '@' 便可把帳號設成他人的 email 製造混淆。
export const normUsername = (v: unknown): string => String(v ?? '').trim().toLowerCase();
export function usernameIssue(u: string): string | null {
  if (!u) return '登入帳號為必填';
  if (u.length < 3 || u.length > 32) return '登入帳號需 3～32 字元';
  if (u.includes('@')) return '登入帳號不可包含 @（避免與 Email 混淆）';
  if (!/^[a-z0-9._-]+$/.test(u)) return '登入帳號僅可使用英數字與 . _ -';
  return null;
}

// 密碼規則（設定新密碼時檢查）：至少 8 碼、需同時包含英文字母與數字（符號可有可無，不強制）、
// 非單一重複字元、非常見弱密碼、不同於帳號。
// 回傳錯誤訊息字串，或 null 表示通過。登入驗證不受此限（既有較短密碼仍可登入直到更換）。
// account 可傳多個識別（如帳號與 email），皆不得作為密碼。
type Acct = string | null | undefined;
export function passwordIssue(pw: string, account?: Acct | Acct[]): string | null {
  if (!pw || pw.length < 8) return '密碼至少 8 碼';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return '密碼需同時包含英文字母與數字';
  if (/^(.)\1+$/.test(pw)) return '密碼過於簡單，請勿使用單一重複字元';
  if (COMMON_WEAK.has(pw.toLowerCase())) return '密碼過於常見，請改用較複雜的密碼';
  for (const a of (Array.isArray(account) ? account : [account])) {
    if (a && pw.toLowerCase() === String(a).toLowerCase()) return '密碼不可與帳號相同';
  }
  return null;
}

// Turnstile 驗證：未設定 secret 時略過（回 true，不阻擋）
export async function verifyTurnstile(secret: string | undefined, token: unknown, ip?: string): Promise<boolean> {
  if (!secret) return true;
  if (!token || typeof token !== 'string') return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip && ip !== 'unknown') form.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const d = (await r.json()) as { success?: boolean };
    return !!d.success;
  } catch { return false; }
}
