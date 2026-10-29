// 產生與 src/auth.ts 相容的 PBKDF2 密碼雜湊（建立管理者帳號用）。
// 用法：node scripts/hash-password.mjs '你的密碼'
const enc = new TextEncoder();
const ITER = 100000;
const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

const pw = process.argv[2];
if (!pw) { console.error('usage: node scripts/hash-password.mjs <password>'); process.exit(1); }
const salt = crypto.getRandomValues(new Uint8Array(16));
const h = await pbkdf2(pw, salt, ITER);
process.stdout.write(`pbkdf2$${ITER}$${b64(salt)}$${b64(h)}\n`);
