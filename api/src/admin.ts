// 後台 API：管理者登入、公告 CRUD、分類。掛載於 /api/admin。
import { Hono } from 'hono';
import {
  hashPassword, verifyPassword, adminSessions, type Session,
  rlCheck, rlBump, rlReset, verifyTurnstile, recordAudit, passwordIssue,
  acctKey, acctWait, acctFail, normUsername, usernameIssue, generatePassword, diffFields,
} from './auth';
import { background, clientIp } from './platform';
import { attachmentFilename } from './files';

type Bindings = {
  DB: D1Database; KV: KVNamespace; FILES: R2Bucket;
  ENVIRONMENT?: string; TURNSTILE_SECRET?: string;
};
type Vars = { admin: Session; token: string };

export const admin = new Hono<{ Bindings: Bindings; Variables: Vars }>();

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toISOString().slice(0, 10);
async function audit(c: any, action: string, entity: string, id: string | number | undefined, changes?: unknown) {
  try {
    await c.env.DB.prepare('insert into audit_logs (admin_user_id,action,entity_type,entity_id,changes,ip) values (?,?,?,?,?,?)')
      .bind(c.get('admin')?.uid ?? null, action, entity, String(id), changes ? JSON.stringify(changes) : null,
        clientIp(c)).run();
  } catch { /* audit best-effort */ }
}

// ── 公開（未受保護）：登入 / 登出 ─────────────────────────────
admin.post('/login', async (c) => {
  const { username, password, turnstileToken } = await c.req.json().catch(() => ({}));
  if (!username || !password) return c.json({ error: '請輸入帳號與密碼' }, 400);
  // 帳號一律不分大小寫比對（見 auth.ts 的 normUsername；建立管理員帳號時也會正規化）。
  const uname = normUsername(username);
  const ip = clientIp(c);
  const rlKey = 'rl:alogin:' + ip;
  if (await rlCheck(c.env.KV, rlKey, 10)) return c.json({ error: '登入嘗試過多，請 15 分鐘後再試' }, 429);
  // 以帳號為單位的遞增退避（同會員登入；管理者帳號雖不公開，但價值更高，故一併防護）
  const aKey = acctKey('rl:alogin:a:', uname);
  const wait = await acctWait(c.env.KV, aKey);
  if (wait > 0) return c.json({ error: `登入嘗試過多，請 ${wait} 秒後再試` }, 429);
  if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET, turnstileToken, ip))) return c.json({ error: '人機驗證失敗，請重新驗證' }, 403);
  const u = await c.env.DB.prepare('select id,username,password_hash,name,role,is_active,token_version from admin_users where username=?')
    .bind(uname).first<any>();
  if (!u || !u.is_active || !(await verifyPassword(password, u.password_hash))) {
    await rlBump(c.env.KV, rlKey, 900);
    await acctFail(c.env.KV, aKey);
    await recordAudit(c.env.DB, { action: 'login-failed', entityType: 'admin', entityId: String(username).slice(0, 64), ip });
    return c.json({ error: '帳號或密碼錯誤' }, 401);
  }
  await rlReset(c.env.KV, rlKey);
  await rlReset(c.env.KV, aKey);
  const sess: Session = { uid: u.id, role: u.role, name: u.name, username: u.username, tv: u.token_version ?? 0 };
  const t = await adminSessions.create(c.env.KV, sess);
  adminSessions.setCookie(c, t);
  background(c, c.env.DB.prepare('update admin_users set last_login_at=? where id=?').bind(now(), u.id).run());
  return c.json({ user: { name: u.name, role: u.role, username: u.username } });
});

admin.post('/logout', async (c) => {
  await adminSessions.destroy(c.env.KV, adminSessions.readToken(c));
  adminSessions.clearCookie(c);
  return c.json({ ok: true });
});

// ── 認證中介層（以下路由皆需登入）──────────────────────────────
admin.use('*', async (c, next) => {
  const t = adminSessions.readToken(c);
  const sess = await adminSessions.get(c.env.KV, t);
  if (!sess) return c.json({ error: 'unauthorized' }, 401);
  // 回查 DB：帳號停用／刪除、或改密碼（token_version 不符）即時失效；角色以 DB 為準（即時反映降級）。
  const u = await c.env.DB.prepare('select is_active, role, token_version from admin_users where id=?').bind(sess.uid).first<any>();
  if (!u || !u.is_active || (u.token_version ?? 0) !== (sess.tv ?? 0)) {
    await adminSessions.destroy(c.env.KV, t);
    return c.json({ error: 'unauthorized' }, 401);
  }
  sess.role = u.role;
  c.set('admin', sess);
  c.set('token', t as string);
  // 滑動續期（idle 過半才刷新，且不超過絕對上限）；有續期則重發 cookie。
  if (await adminSessions.touch(c.env.KV, t as string, sess)) adminSessions.setCookie(c, t as string);
  await next();
});

const canWrite = (c: any) => c.get('admin').role !== 'viewer';
const isSuper = (c: any) => c.get('admin').role === 'superadmin';
const ROLES = ['superadmin', 'editor', 'viewer'];
// 列表分頁參數（limit 1–100，預設 50）
const pageParams = (c: any) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100),
  offset: Math.max(Number(c.req.query('offset')) || 0, 0),
});
// 上傳檔案大小上限（位元組）；如需放寬改這裡即可
const MAX_UPLOAD = 15 * 1024 * 1024; // 15 MB
// 允許的上傳副檔名（白名單；排除 svg/html/js 等可被當頁面執行的類型）
const ALLOWED_UPLOAD_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt',
  'odt', 'ods', 'odp', 'odg', 'odb', // OpenDocument
  'zip', 'rar', '7z', // 壓縮檔
  'jpg', 'jpeg', 'png', 'gif', 'webp',
]);

admin.get('/me', (c) => c.json({ user: c.get('admin') }));

// ── 管理員管理（僅最高管理員 superadmin）─────────────────────────
admin.get('/admins', async (c) => {
  if (!isSuper(c)) return c.json({ error: 'forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    'select id,username,name,email,role,is_active,last_login_at,created_at from admin_users order by id',
  ).all();
  return c.json({ items: results });
});
admin.post('/admins', async (c) => {
  if (!isSuper(c)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({} as any));
  // 帳號一律正規化成小寫（同 login 的比對規則），避免建立時打的大小寫跟之後登入時不同，
  // 查無此帳號卻表現得像「密碼錯誤」。
  const username = normUsername(b.username);
  const name = String(b.name || '').trim();
  const role = ROLES.includes(b.role) ? b.role : 'editor';
  const pw = String(b.password || '');
  if (!username || !name) return c.json({ error: '帳號與姓名為必填' }, 400);
  if (pw.length < 8) return c.json({ error: '密碼至少 8 碼' }, 400);
  const dup = await c.env.DB.prepare('select id from admin_users where username=?').bind(username).first();
  if (dup) return c.json({ error: '帳號已存在' }, 400);
  const r = await c.env.DB.prepare('insert into admin_users (username,password_hash,name,email,role) values (?,?,?,?,?)')
    .bind(username, await hashPassword(pw), name, b.email ? String(b.email).trim() : null, role).run();
  await audit(c, 'create', 'admin_user', r.meta.last_row_id);
  return c.json({ id: r.meta.last_row_id });
});
admin.put('/admins/:id', async (c) => {
  if (!isSuper(c)) return c.json({ error: 'forbidden' }, 403);
  const id = Number(c.req.param('id'));
  const me = c.get('admin');
  const b = await c.req.json().catch(() => ({} as any));
  const name = String(b.name || '').trim();
  if (!name) return c.json({ error: '姓名為必填' }, 400);
  const target = await c.env.DB.prepare('select id,role,is_active from admin_users where id=?').bind(id).first<any>();
  if (!target) return c.json({ error: 'not found' }, 404);
  const role = ROLES.includes(b.role) ? b.role : target.role;
  const isActive = (b.is_active === false || b.is_active === 0) ? 0 : 1;
  if (id === me.uid && (isActive === 0 || role !== 'superadmin')) {
    return c.json({ error: '無法停用或降級自己的帳號' }, 400);
  }
  if (target.role === 'superadmin' && (role !== 'superadmin' || isActive === 0)) {
    const others = await c.env.DB.prepare("select count(*) as n from admin_users where role='superadmin' and is_active=1 and id<>?").bind(id).first<any>();
    if ((others?.n || 0) === 0) return c.json({ error: '系統至少需保留一位啟用的最高管理員' }, 400);
  }
  await c.env.DB.prepare('update admin_users set name=?, email=?, role=?, is_active=?, updated_at=? where id=?')
    .bind(name, b.email ? String(b.email).trim() : null, role, isActive, now(), id).run();
  await audit(c, 'update', 'admin_user', id);
  return c.json({ ok: true });
});
admin.post('/admins/:id/password', async (c) => {
  if (!isSuper(c)) return c.json({ error: 'forbidden' }, 403);
  const id = Number(c.req.param('id'));
  const b = await c.req.json().catch(() => ({} as any));
  const target = await c.env.DB.prepare('select username from admin_users where id=?').bind(id).first<any>();
  if (!target) return c.json({ error: 'not found' }, 404);
  const issue = passwordIssue(String(b.password || ''), target.username);
  if (issue) return c.json({ error: issue }, 400);
  // token_version+1：使該管理員既有 session 全數失效（強制重新登入）。
  await c.env.DB.prepare('update admin_users set password_hash=?, token_version=token_version+1, updated_at=? where id=?')
    .bind(await hashPassword(String(b.password)), now(), id).run();
  const me = c.get('admin');
  if (id === me.uid) { me.tv = (me.tv ?? 0) + 1; await adminSessions.rewrite(c.env.KV, c.get('token'), me); adminSessions.setCookie(c, c.get('token')); }
  await audit(c, 'reset-password', 'admin_user', id);
  return c.json({ ok: true });
});

// ── 操作紀錄（稽核日誌；僅 superadmin，唯讀分頁）─────────────────
admin.get('/audit-logs', async (c) => {
  if (!isSuper(c)) return c.json({ error: 'forbidden' }, 403);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const q = (c.req.query('q') || '').trim();
  const action = (c.req.query('action') || '').trim();
  const entityType = (c.req.query('entity_type') || '').trim();
  const from = (c.req.query('from') || '').trim();
  const to = (c.req.query('to') || '').trim();
  const conds: string[] = []; const binds: any[] = [];
  // q 同時比對管理員帳號/姓名、對象類型、對象 id、來源 IP、變更內容——變更內容裡的 member_no／
  // name（見 admin.ts 的 diffFields 用法、member.ts 的 self-update）讓「查某會員被誰改過」查得到，
  // 不必先知道內部 id。
  if (q) {
    conds.push('(u.username like ? or u.name like ? or l.entity_type like ? or l.entity_id like ? or l.ip like ? or l.changes like ?)');
    binds.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  if (action) { conds.push('l.action = ?'); binds.push(action); }
  if (entityType) { conds.push('l.entity_type = ?'); binds.push(entityType); }
  // created_at 為 'YYYY-MM-DD HH:MM:SS'，取 date() 比對才能含頭含尾。
  if (isYmd(from)) { conds.push('date(l.created_at) >= ?'); binds.push(from); }
  if (isYmd(to)) { conds.push('date(l.created_at) <= ?'); binds.push(to); }
  const where = conds.length ? 'where ' + conds.join(' and ') : '';
  const { results } = await c.env.DB.prepare(
    `select l.id,l.action,l.entity_type,l.entity_id,l.changes,l.ip,l.created_at,
            u.name as admin_name, u.username as admin_username
       from audit_logs l left join admin_users u on u.id=l.admin_user_id
      ${where}
      order by l.id desc limit ? offset ?`,
  ).bind(...binds, limit + 1, offset).all();
  const items = results.slice(0, limit);
  // 下拉選單選項：取實際出現過的值，跟會費頁「會期」下拉同一套做法。
  const [actionsR, entityTypesR] = await Promise.all([
    c.env.DB.prepare('select distinct action from audit_logs order by action').all(),
    c.env.DB.prepare("select distinct entity_type from audit_logs where entity_type is not null and entity_type<>'' order by entity_type").all(),
  ]);
  return c.json({
    items, hasMore: results.length > limit,
    actions: actionsR.results.map((r: any) => r.action),
    entityTypes: entityTypesR.results.map((r: any) => r.entity_type),
    filtered: !!(q || action || entityType || isYmd(from) || isYmd(to)),
  });
});

// 管理者變更自己的密碼（需提供目前密碼）
admin.post('/change-password', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const me = c.get('admin');
  const issue = passwordIssue(String(b.new_password || ''), me.username);
  if (issue) return c.json({ error: issue }, 400);
  const u = await c.env.DB.prepare('select password_hash from admin_users where id=?').bind(me.uid).first<any>();
  if (!u || !(await verifyPassword(String(b.current_password || ''), u.password_hash))) return c.json({ error: '目前密碼不正確' }, 400);
  // token_version+1：使其他既有 session 失效；再同步當前 session 保持自己登入。
  await c.env.DB.prepare('update admin_users set password_hash=?, token_version=token_version+1, updated_at=? where id=?')
    .bind(await hashPassword(String(b.new_password)), now(), me.uid).run();
  me.tv = (me.tv ?? 0) + 1;
  await adminSessions.rewrite(c.env.KV, c.get('token'), me);
  adminSessions.setCookie(c, c.get('token'));
  await audit(c, 'change-password', 'admin_user', me.uid);
  return c.json({ ok: true });
});

// 分類（含 member scope，給後台表單用）
admin.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare('select id,name,color,scope from announcement_categories order by scope, sort_order').all();
  return c.json({ items: results });
});

// ── 公告分類管理（獨立於上方唯讀 /categories；含 scope 驗證與「使用中擋刪」）──
const annCatFields = (b: any) => ({
  name: String(b?.name ?? '').trim(),
  color: (b?.color == null || b.color === '') ? null : String(b.color),
  scope: b?.scope === 'member' ? 'member' : 'public',
  sort_order: Number(b?.sort_order) || 0,
});
const annCatUsage = async (c: any, id: string | number): Promise<number> => {
  const r = await c.env.DB.prepare('select count(*) as n from announcements where category_id=?').bind(id).first();
  return Number(r?.n) || 0;
};

admin.get('/announcement-categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    'select id,name,color,scope,sort_order from announcement_categories order by scope, sort_order, id').all();
  return c.json({ items: results });
});
admin.get('/announcement-categories/:id', async (c) => {
  const item = await c.env.DB.prepare(
    'select id,name,color,scope,sort_order from announcement_categories where id=?').bind(c.req.param('id')).first();
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json({ item });
});
admin.post('/announcement-categories', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const a = annCatFields(await c.req.json().catch(() => ({})));
  if (!a.name) return c.json({ error: '名稱為必填' }, 400);
  const r = await c.env.DB.prepare('insert into announcement_categories (name,color,scope,sort_order) values (?,?,?,?)')
    .bind(a.name, a.color, a.scope, a.sort_order).run();
  await audit(c, 'create', 'announcement_category', r.meta.last_row_id, a);
  return c.json({ id: r.meta.last_row_id });
});
admin.put('/announcement-categories/:id', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const cur = await c.env.DB.prepare('select scope from announcement_categories where id=?').bind(id).first<{ scope: string }>();
  if (!cur) return c.json({ error: 'not found' }, 404);
  const a = annCatFields(await c.req.json().catch(() => ({})));
  if (!a.name) return c.json({ error: '名稱為必填' }, 400);
  // 在用時不可變更適用對象（scope），避免公告的 visibility 與分類 scope 不一致
  if (a.scope !== cur.scope) {
    const used = await annCatUsage(c, id);
    if (used > 0) return c.json({ error: `此分類仍有 ${used} 則公告使用中，無法變更「適用對象」；請先調整相關公告的分類。` }, 400);
  }
  await c.env.DB.prepare('update announcement_categories set name=?,color=?,scope=?,sort_order=? where id=?')
    .bind(a.name, a.color, a.scope, a.sort_order, id).run();
  await audit(c, 'update', 'announcement_category', id, a);
  return c.json({ ok: true });
});
admin.delete('/announcement-categories/:id', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const used = await annCatUsage(c, id);
  if (used > 0) return c.json({ error: `此分類仍有 ${used} 則公告使用中，請先移除或改分類後再刪除。` }, 400);
  await c.env.DB.prepare('delete from announcement_categories where id=?').bind(id).run();
  await audit(c, 'delete', 'announcement_category', id);
  return c.json({ ok: true });
});

// ── 公告 CRUD ─────────────────────────────────────────────────
admin.get('/announcements', async (c) => {
  const { limit, offset } = pageParams(c);
  const q = c.req.query('q');
  const categoryId = Number(c.req.query('category_id')) || 0;
  const status = c.req.query('status');
  const visibility = c.req.query('visibility');
  const binds: any[] = [];
  const conds: string[] = [];
  if (q) { conds.push('a.title like ?'); binds.push('%' + q + '%'); }
  if (categoryId) { conds.push('a.category_id = ?'); binds.push(categoryId); }
  if (status && ['draft', 'scheduled', 'published', 'archived'].includes(status)) { conds.push('a.status = ?'); binds.push(status); }
  if (visibility && ['public', 'member'].includes(visibility)) { conds.push('a.visibility = ?'); binds.push(visibility); }
  const where = conds.length ? 'where ' + conds.join(' and ') : '';
  const { results } = await c.env.DB.prepare(
    `select a.id,a.visibility,a.title,a.publish_date,a.is_pinned,a.show_in_list,a.status,a.views,
            c.name as category
       from announcements a join announcement_categories c on c.id=a.category_id
       ${where} order by a.publish_date desc, a.id desc limit ? offset ?`,
  ).bind(...binds, limit + 1, offset).all();
  return c.json({ items: results.slice(0, limit), hasMore: results.length > limit });
});

admin.get('/announcements/:id', async (c) => {
  const item = await c.env.DB.prepare('select * from announcements where id=?').bind(c.req.param('id')).first<any>();
  if (!item) return c.json({ error: 'not found' }, 404);
  try { item.body = item.body ? JSON.parse(item.body) : null; } catch { /* keep raw */ }
  const { results: files } = await c.env.DB.prepare(
    "select id,name,file_path,size_bytes,type,access,file_date from attachments where owner_type='announcement' and owner_id=? order by sort_order",
  ).bind(item.id).all();
  return c.json({ item, files });
});

const ann = (b: any) => ({
  visibility: b.visibility === 'member' ? 'member' : 'public',
  category_id: Number(b.category_id),
  title: String(b.title || '').trim(),
  excerpt: b.excerpt ? String(b.excerpt) : null,
  body: b.body ? JSON.stringify(b.body) : null,
  publish_date: String(b.publish_date || '').replace('T', ' ').slice(0, 16),
  is_pinned: b.is_pinned ? 1 : 0,
  show_in_list: b.show_in_list === false ? 0 : 1,
  status: ['draft', 'scheduled', 'published', 'archived'].includes(b.status) ? b.status : 'draft',
});

admin.post('/announcements', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const a = ann(b);
  if (!a.title || !a.category_id || !a.publish_date) return c.json({ error: '標題、分類、發布日期為必填' }, 400);
  const uid = c.get('admin').uid;
  const r = await c.env.DB.prepare(
    `insert into announcements (visibility,category_id,title,excerpt,body,publish_date,is_pinned,show_in_list,status,published_at,created_by,updated_by)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(a.visibility, a.category_id, a.title, a.excerpt, a.body, a.publish_date, a.is_pinned, a.show_in_list, a.status,
    a.status === 'published' ? now() : null, uid, uid).run();
  const id = r.meta.last_row_id;
  await audit(c, 'create', 'announcement', id, a);
  return c.json({ id });
});

admin.put('/announcements/:id', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('select id,visibility from announcements where id=?').bind(id).first<any>();
  if (!exists) return c.json({ error: 'not found' }, 404);
  const a = ann(await c.req.json().catch(() => ({})));
  if (!a.title || !a.category_id || !a.publish_date) return c.json({ error: '標題、分類、發布日期為必填' }, 400);
  // 公開 → 會員限定：附件必須一併移入 member/ 前綴，否則原本的公開網址仍下載得到。
  // 反向（會員限定 → 公開）刻意不自動解鎖，維持鎖定狀態由管理者逐一確認，避免誤放。
  const warnings: string[] = [];
  if (exists.visibility !== 'member' && a.visibility === 'member') {
    const { results } = await c.env.DB.prepare(
      "select id,name,file_path from attachments where owner_type='announcement' and owner_id=? and access='public'",
    ).bind(id).all();
    for (const at of results as any[]) {
      if (!at.file_path) { await c.env.DB.prepare("update attachments set access='member' where id=?").bind(at.id).run(); continue; }
      try {
        const key = await moveObject(c.env.FILES, at.file_path, 'member');
        await c.env.DB.prepare("update attachments set access='member',file_path=? where id=?").bind(key, at.id).run();
      } catch (e: any) {
        warnings.push(`附件「${at.name}」未能上鎖（${e.message || '搬移失敗'}），目前仍可經原網址下載。`);
      }
    }
  }
  await c.env.DB.prepare(
    `update announcements set visibility=?,category_id=?,title=?,excerpt=?,body=?,publish_date=?,is_pinned=?,show_in_list=?,status=?,updated_by=?,updated_at=?
      where id=?`,
  ).bind(a.visibility, a.category_id, a.title, a.excerpt, a.body, a.publish_date, a.is_pinned, a.show_in_list, a.status,
    c.get('admin').uid, now(), id).run();
  await audit(c, 'update', 'announcement', id, warnings.length ? { ...a, warnings } : a);
  return c.json({ ok: true, warnings });
});

admin.delete('/announcements/:id', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const { results: atts } = await c.env.DB.prepare("select file_path from attachments where owner_type='announcement' and owner_id=?").bind(id).all();
  for (const a of atts as any[]) { if (a.file_path) { try { await c.env.FILES.delete(a.file_path); } catch { /* best-effort */ } } }
  await c.env.DB.prepare("delete from attachments where owner_type='announcement' and owner_id=?").bind(id).run();
  await c.env.DB.prepare('delete from announcements where id=?').bind(id).run();
  await audit(c, 'delete', 'announcement', id);
  return c.json({ ok: true });
});

// 公告附件（R2）
// 權限實際靠 R2 key 前綴把關：member/ 開頭的物件公開 /files/* 一律拒絕，只能經認證端點取得。
// 因此切換權限一定要連實體檔一起搬，否則會出現「後台顯示已鎖、原網址仍下載得到」的假鎖。
const memberKey = (key: string) => 'member/' + key.replace(/^member\//, '');
const publicKey = (key: string) => key.replace(/^member\//, '');
/** 將 R2 物件搬到目標權限對應的前綴，回傳新 key（已在正確前綴則原樣返回）。 */
async function moveObject(bucket: R2Bucket, key: string, want: 'public' | 'member'): Promise<string> {
  const target = want === 'member' ? memberKey(key) : publicKey(key);
  if (target === key) return key;
  const obj = await bucket.get(key);
  if (!obj) throw new Error('找不到實體檔案，請刪除此附件後重新上傳。');
  await bucket.put(target, obj.body, { httpMetadata: obj.httpMetadata });
  try {
    await bucket.delete(key);
  } catch {
    // 上鎖方向若刪不掉舊的公開檔，等於沒鎖成 → 復原並回報，不可當作成功。
    // 解鎖方向殘留的 member/ 舊檔無法被公開取得，僅佔空間，容忍。
    if (want === 'member') { try { await bucket.delete(target); } catch { /* ignore */ } throw new Error('舊檔清除失敗，權限未變更，請稍後再試。'); }
  }
  return target;
}

admin.post('/announcements/:id/attachments', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({} as any));
  if (!b.file_path) return c.json({ error: '缺少檔案' }, 400);
  const row = await c.env.DB.prepare("select coalesce(max(sort_order),-1)+1 as n from attachments where owner_type='announcement' and owner_id=?").bind(id).first<{ n: number }>();
  // access 以實際 key 前綴為準，資料庫欄位才不會與可及性脫節。
  const access = String(b.file_path).startsWith('member/') ? 'member' : 'public';
  // file_date 預設為上傳日，前台檔案列據此顯示更新日期；之後可用下方端點改。
  const fileDate = b.file_date ? String(b.file_date).slice(0, 10) : today();
  const r = await c.env.DB.prepare("insert into attachments (owner_type,owner_id,name,file_path,size_bytes,type,sort_order,access,file_date) values ('announcement',?,?,?,?,?,?,?,?)")
    .bind(id, b.name || b.file_path, b.file_path, b.size_bytes || 0, b.type || 'pdf', row ? row.n : 0, access, fileDate).run();
  return c.json({ id: r.meta.last_row_id, access, file_date: fileDate });
});

// 附件的顯示資訊（檔名／更新日期）。實體檔與權限不由此端點更動 ——
// 換檔請刪除後重新上傳，權限走上面的 /access（要搬 R2 物件）。
admin.put('/attachments/:id', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({} as any));
  const sets: string[] = []; const vals: (string | null)[] = [];
  if (typeof b.name === 'string') {
    const name = b.name.trim();
    if (!name) return c.json({ error: '檔名不可為空' }, 400);
    sets.push('name=?'); vals.push(name);
  }
  if ('file_date' in b) {
    const d = b.file_date ? String(b.file_date).slice(0, 10) : null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return c.json({ error: '日期格式需為 YYYY-MM-DD' }, 400);
    sets.push('file_date=?'); vals.push(d);
  }
  if (!sets.length) return c.json({ error: '沒有要更新的欄位' }, 400);
  const r = await c.env.DB.prepare(`update attachments set ${sets.join(',')} where id=?`).bind(...vals, id).run();
  if (!r.meta.changes) return c.json({ error: 'not found' }, 404);
  await audit(c, 'update', 'attachment', id, b);
  return c.json({ ok: true });
});

// 個別附件的「需登入下載」開關（單向：僅公開公告可調整）
admin.put('/attachments/:id/access', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const want = (await c.req.json().catch(() => ({} as any))).access === 'member' ? 'member' : 'public';
  const row = await c.env.DB.prepare(
    `select at.file_path, at.access, a.visibility from attachments at
       join announcements a on a.id=at.owner_id
      where at.id=? and at.owner_type='announcement'`,
  ).bind(id).first<any>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.visibility === 'member') return c.json({ error: '「會員限定」公告的附件一律需登入下載，無法個別調整。' }, 400);
  if (row.access === want) return c.json({ ok: true, access: want, file_path: row.file_path });
  let key = row.file_path as string;
  if (key) {
    try { key = await moveObject(c.env.FILES, key, want); }
    catch (e: any) { return c.json({ error: e.message || '搬移檔案失敗' }, 400); }
  }
  await c.env.DB.prepare('update attachments set access=?,file_path=? where id=?').bind(want, key, id).run();
  await audit(c, 'update', 'attachment', id, { access: want });
  return c.json({ ok: true, access: want, file_path: key });
});
// 後台檢視附件（需登入後台）：member/ 前綴的檔案公開 /files/* 取不到，
// 管理者仍需能確認自己上傳／上鎖的檔案內容。
admin.get('/attachments/:id/download', async (c) => {
  const a = await c.env.DB.prepare('select name,file_path from attachments where id=?').bind(c.req.param('id')).first<any>();
  if (!a || !a.file_path) return c.notFound();
  const obj = await c.env.FILES.get(a.file_path);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachmentFilename(a.name, a.file_path))}`);
  return new Response(obj.body, { headers });
});
admin.delete('/attachments/:id', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const a = await c.env.DB.prepare('select file_path from attachments where id=?').bind(c.req.param('id')).first<any>();
  if (a && a.file_path) { try { await c.env.FILES.delete(a.file_path); } catch { /* best-effort */ } }
  await c.env.DB.prepare('delete from attachments where id=?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// 所有公告附件（容量管理：預設依大小排序，附總用量）
// 支援 q（檔名或所屬公告標題）與 from/to（上傳日期區間）篩選。
// 不只檢查格式（正則）——也檢查是不是真的存在的日期（如 2026-13-45 這種格式對但日期不存在）。
const isYmd = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
admin.get('/attachments', async (c) => {
  const { limit, offset } = pageParams(c);
  const s = c.req.query('sort');
  const order = s === 'date' ? 'a.created_at desc, a.id desc'
    : s === 'date_asc' ? 'a.created_at asc, a.id asc'
    : 'a.size_bytes desc';
  const q = (c.req.query('q') || '').trim();
  const from = (c.req.query('from') || '').trim();
  const to = (c.req.query('to') || '').trim();
  const conds = ["a.owner_type='announcement'"];
  const binds: any[] = [];
  // 檔名或所屬公告標題任一命中即算；孤兒附件（公告已不存在）仍可用檔名搜到。
  if (q) { conds.push('(a.name like ? or an.title like ?)'); binds.push('%' + q + '%', '%' + q + '%'); }
  // created_at 為 'YYYY-MM-DD HH:MM:SS'，取 date() 比對才能含頭含尾（直接比字串會漏掉 to 當天）。
  if (isYmd(from)) { conds.push('date(a.created_at) >= ?'); binds.push(from); }
  if (isYmd(to)) { conds.push('date(a.created_at) <= ?'); binds.push(to); }
  const where = conds.join(' and ');
  const { results } = await c.env.DB.prepare(
    `select a.id,a.name,a.file_path,a.size_bytes,a.type,a.owner_id,a.created_at,a.access,
            an.title as ann_title, an.visibility as ann_visibility
       from attachments a left join announcements an on an.id=a.owner_id
      where ${where}
      order by ${order} limit ? offset ?`,
  ).bind(...binds, limit + 1, offset).all();
  // 統計與清單套用同一組條件，數字才會與眼前的列表一致。
  const total = await c.env.DB.prepare(
    `select count(*) as n, coalesce(sum(a.size_bytes),0) as bytes
       from attachments a left join announcements an on an.id=a.owner_id
      where ${where}`,
  ).bind(...binds).first<any>();
  return c.json({
    items: results.slice(0, limit), hasMore: results.length > limit,
    totalCount: total?.n || 0, totalBytes: total?.bytes || 0, filtered: !!(q || isYmd(from) || isYmd(to)),
  });
});

// ── 泛型 CRUD 工廠（table / cols 皆為程式內定義，非使用者輸入）─────────────
// fileCol 存的值有兩種寫法：documents 存純 R2 key（documents/xxx.pdf），輪播背景圖比照相簿照片、
// 會員照片存前台可直接用的網址（/files/hero/xxx.jpg）。刪檔前先統一成 R2 key；站內靜態資源
// （assets/…，種子資料的預設背景圖）與外部網址不在 R2 裡，回 null 跳過不刪。
const r2KeyOf = (p: unknown): string | null => {
  const v = String(p || '').trim();
  if (!v || /^(https?:)?\/\//i.test(v) || /^\/?assets\//.test(v)) return null;
  return v.replace(/^\/files\//, '');
};
const deleteR2 = async (c: any, p: unknown) => {
  const key = r2KeyOf(p);
  if (key) { try { await c.env.FILES.delete(key); } catch { /* best-effort */ } }
};
type Field = { col: string; kind?: 'int' | 'bool' | 'json' | 'text'; required?: boolean; def?: any };
function registerCrud(base: string, table: string, fields: Field[], opts: {
  fileCol?: string; paginate?: boolean; listOrder?: string; searchCol?: string; filterCol?: string;
  beforeSave?: (o: any, c: any) => Promise<void> | void;
} = {}) {
  const cols = fields.map((f) => f.col);
  const jsonCols = fields.filter((f) => f.kind === 'json').map((f) => f.col);
  const parseRow = (r: any) => { for (const jc of jsonCols) { try { r[jc] = r[jc] ? JSON.parse(r[jc]) : null; } catch { /* keep */ } } return r; };
  const coerce = (b: any) => {
    const o: any = {};
    for (const f of fields) {
      let v = b[f.col];
      if (v === undefined) v = f.def !== undefined ? f.def : (f.kind === 'bool' ? 0 : f.kind === 'int' ? 0 : null);
      if (f.kind === 'bool') v = v ? 1 : 0;
      else if (f.kind === 'int') v = (v === null || v === '') ? 0 : Number(v);
      else if (f.kind === 'json') v = v == null ? null : JSON.stringify(v);
      else v = (v == null || v === '') ? (f.required ? '' : null) : String(v);
      o[f.col] = v;
    }
    return o;
  };
  const missingReq = (o: any) => fields.find((f) => f.required && (o[f.col] === '' || o[f.col] == null));

  const listOrder = opts.listOrder || 'sort_order, id';
  admin.get(base, async (c) => {
    const conds: string[] = []; const binds: unknown[] = [];
    if (opts.searchCol) {
      const q = c.req.query('q');
      if (q) { conds.push(`${opts.searchCol} like ?`); binds.push(`%${q}%`); }
    }
    if (opts.filterCol) {
      const fv = c.req.query(opts.filterCol);
      if (fv) { conds.push(`${opts.filterCol} = ?`); binds.push(fv); }
    }
    const where = conds.length ? `where ${conds.join(' and ')} ` : '';
    if (opts.paginate) {
      const { limit, offset } = pageParams(c);
      const { results } = await c.env.DB.prepare(`select * from ${table} ${where}order by ${listOrder} limit ? offset ?`).bind(...binds, limit + 1, offset).all();
      return c.json({ items: (results as any[]).slice(0, limit).map(parseRow), hasMore: results.length > limit });
    }
    const { results } = await c.env.DB.prepare(`select * from ${table} ${where}order by ${listOrder}`).bind(...binds).all();
    return c.json({ items: (results as any[]).map(parseRow) });
  });
  admin.get(base + '/:id', async (c) => {
    const r = await c.env.DB.prepare(`select * from ${table} where id=?`).bind(c.req.param('id')).first();
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json({ item: parseRow(r) });
  });
  admin.post(base, async (c) => {
    if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
    const o = coerce(await c.req.json().catch(() => ({})));
    if (opts.beforeSave) await opts.beforeSave(o, c);
    const miss = missingReq(o);
    if (miss) return c.json({ error: `${miss.col} 為必填` }, 400);
    const r = await c.env.DB.prepare(`insert into ${table} (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`)
      .bind(...cols.map((c2) => o[c2])).run();
    await audit(c, 'create', table, r.meta.last_row_id, o);
    return c.json({ id: r.meta.last_row_id });
  });
  admin.put(base + '/:id', async (c) => {
    if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id');
    if (!(await c.env.DB.prepare(`select id from ${table} where id=?`).bind(id).first())) return c.json({ error: 'not found' }, 404);
    const o = coerce(await c.req.json().catch(() => ({})));
    if (opts.beforeSave) await opts.beforeSave(o, c);
    const miss = missingReq(o);
    if (miss) return c.json({ error: `${miss.col} 為必填` }, 400);
    // 換檔或清空時把舊檔從 R2 拿掉，不然每換一次就留一個沒人指到的孤兒檔。
    let oldFile: unknown = null;
    if (opts.fileCol) {
      const row = await c.env.DB.prepare(`select ${opts.fileCol} as fp from ${table} where id=?`).bind(id).first<any>();
      oldFile = row ? row.fp : null;
    }
    await c.env.DB.prepare(`update ${table} set ${cols.map((c2) => c2 + '=?').join(',')} where id=?`)
      .bind(...cols.map((c2) => o[c2]), id).run();
    if (opts.fileCol && oldFile && oldFile !== o[opts.fileCol]) await deleteR2(c, oldFile);
    await audit(c, 'update', table, id, o);
    return c.json({ ok: true });
  });
  admin.delete(base + '/:id', async (c) => {
    if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id');
    if (opts.fileCol) {
      const row = await c.env.DB.prepare(`select ${opts.fileCol} as fp from ${table} where id=?`).bind(id).first<any>();
      if (row && row.fp) await deleteR2(c, row.fp);
    }
    await c.env.DB.prepare(`delete from ${table} where id=?`).bind(id).run();
    await audit(c, 'delete', table, id);
    return c.json({ ok: true });
  });
}

registerCrud('/friends', 'friend_links', [
  { col: 'name', required: true }, { col: 'url' }, { col: 'is_active', kind: 'bool', def: 1 }, { col: 'sort_order', kind: 'int' },
]);
// background_image：後台上傳後存 /files/hero/… 網址（種子資料的 assets/… 靜態圖仍相容）；
// 換圖／清空／刪列時由 fileCol 機制清掉 R2 舊檔。
registerCrud('/hero', 'hero_slides', [
  { col: 'background_image' }, { col: 'eyebrow' }, { col: 'title', required: true }, { col: 'description' },
  { col: 'buttons', kind: 'json' }, { col: 'is_active', kind: 'bool', def: 1 }, { col: 'sort_order', kind: 'int' },
], { fileCol: 'background_image' });
// ── 法律頁面（服務條款／隱私權政策）───────────────────────────
// 固定兩筆（key 由 DB CHECK 限制），沒有新增/刪除，只有讀取跟編輯。
// blocks 欄位相容公告內文的雙格式慣例：字串＝TinyMCE 產生的 HTML，陣列＝舊版區塊 JSON
// （見 web/assets/app.js 的 renderBody／web/admin/admin.js 的 blocksToHtml）。
const LEGAL_KEYS = ['terms', 'privacy'];
admin.get('/legal', async (c) => {
  const { results } = await c.env.DB.prepare(
    `select "key",title,title_en,updated_date,file_key from legal_pages
     order by case "key" when 'terms' then 0 else 1 end`,
  ).all();
  return c.json({ items: results });
});
admin.get('/legal/:key', async (c) => {
  const key = c.req.param('key');
  if (!LEGAL_KEYS.includes(key)) return c.json({ error: 'not found' }, 404);
  const item = await c.env.DB.prepare('select * from legal_pages where "key"=?').bind(key).first<any>();
  if (!item) return c.json({ error: 'not found' }, 404);
  try { item.blocks = JSON.parse(item.blocks); } catch { /* keep raw */ }
  return c.json({ item });
});
admin.put('/legal/:key', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const key = c.req.param('key');
  if (!LEGAL_KEYS.includes(key)) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const title = String(b.title || '').trim();
  if (!title) return c.json({ error: '標題為必填' }, 400);
  await c.env.DB.prepare(
    'update legal_pages set title=?, title_en=?, updated_date=?, blocks=?, file_key=?, updated_at=? where "key"=?',
  ).bind(title, b.title_en ? String(b.title_en).trim() : null, b.updated_date || null,
    JSON.stringify(b.blocks ?? ''), null, now(), key).run();
  await audit(c, 'update', 'legal_page', key);
  return c.json({ ok: true });
});

// ── 檔案上傳（R2）────────────────────────────────────────────
const extKind = (name: string) => {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(e)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(e)) return 'xls';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(e)) return 'img';
  return 'other';
};
admin.post('/upload', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const form = await c.req.formData();
  const entry = form.get('file');
  if (!entry || typeof entry === 'string') return c.json({ error: '缺少檔案' }, 400);
  // workers-types 將 FormData.get 標為 string；執行期實為 File/Blob，故轉型。
  const file = entry as unknown as Blob & { name: string; size: number; type: string };
  if (file.size > MAX_UPLOAD) return c.json({ error: `檔案大小超過上限 ${Math.round(MAX_UPLOAD / 1048576)}MB` }, 400);
  const ext = (file.name || '').toLowerCase().split('.').pop() || '';
  if (!ALLOWED_UPLOAD_EXT.has(ext)) return c.json({ error: '不支援的檔案類型（允許：PDF／Office／OpenDocument／壓縮檔(zip/rar/7z)／CSV／TXT／常見圖片）' }, 400);
  const prefix = ((form.get('prefix') as string) || 'uploads').replace(/[^\w-]/g, '');
  // 輪播背景圖只收圖片：前端 accept 擋得住一般操作，但直接打 API 仍可能塞 PDF 進去，前台會顯示破圖。
  if (prefix === 'hero' && extKind(file.name) !== 'img') return c.json({ error: '背景圖僅接受圖片檔（jpg／png／webp／gif）' }, 400);
  const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((x) => x.toString(16).padStart(2, '0')).join('');
  // scope=member → 置於 member/ 前綴；公開 /files/* 會拒絕該前綴，僅能經認證端點下載。
  const memberScope = String(form.get('scope') || '') === 'member';
  const key = `${memberScope ? 'member/' : ''}${prefix}/${rand}-${safe}`;
  await c.env.FILES.put(key, file, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
  return c.json({ key, url: memberScope ? null : '/files/' + key, size: file.size, type: extKind(file.name), name: file.name });
});

// 後台檔案清單直接下載（需登入後台）：會員限定檔案的 R2 key 帶 member/ 前綴，公開 /files/*
// 一律拒絕，管理者要能自己核對檔案內容得走這支認證端點；公開檔案這裡也一併服務，清單
// 上只需要一個按鈕，不必依 access 動態切換連結目標。
admin.get('/documents/:id/download', async (c) => {
  const d = await c.env.DB.prepare('select name,file_path from documents where id=?').bind(c.req.param('id')).first<any>();
  if (!d || !d.file_path) return c.notFound();
  const obj = await c.env.FILES.get(d.file_path);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachmentFilename(d.name, d.file_path))}`);
  return new Response(obj.body, { headers });
});
registerCrud('/document-categories', 'document_categories', [
  { col: 'name', required: true }, { col: 'access_scope', def: 'both' }, { col: 'sort_order', kind: 'int' },
]);
registerCrud('/documents', 'documents', [
  { col: 'name', required: true }, { col: 'description' }, { col: 'publish_date' },
  { col: 'category_id', kind: 'int', required: true }, { col: 'access', def: 'public' },
  { col: 'file_path' }, { col: 'size_bytes', kind: 'int' }, { col: 'type', def: 'pdf' },
  { col: 'is_active', kind: 'bool', def: 1 }, { col: 'sort_order', kind: 'int', def: 999 },
], {
  fileCol: 'file_path', paginate: true,
  // 後台清單不比照前台的分類＋更新日期排序，改成最單純的「最新上傳在最上面」。
  listOrder: 'created_at desc',
  searchCol: 'name', filterCol: 'category_id',
  // 分類設「會員」時，檔案的「權限」強制鎖成會員限定，避免手殘外流（「公開」與「公開＋會員」
  // 分類底下的檔案本就允許公開／會員限定自由混放，不受限）。
  beforeSave: async (o, c) => {
    if (!o.category_id) return;
    const cat = await c.env.DB.prepare('select access_scope from document_categories where id=?').bind(o.category_id).first();
    if (cat && cat.access_scope === 'member') o.access = 'member';
  },
});

// ── 系統設定（key-value）─────────────────────────────────────
admin.get('/settings', async (c) => {
  const { results } = await c.env.DB.prepare('select "key","value" from settings').all<{ key: string; value: string }>();
  const out: Record<string, unknown> = {};
  for (const r of results) { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; } }
  return c.json({ settings: out });
});
admin.put('/settings/:key', async (c) => {
  if (!canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  const key = c.req.param('key');
  const b = await c.req.json().catch(() => ({} as any));
  await c.env.DB.prepare(
    'insert into settings ("key","value",updated_at) values (?,?,?) on conflict("key") do update set "value"=excluded."value",updated_at=excluded.updated_at',
  ).bind(key, JSON.stringify(b.value ?? null), now()).run();
  await audit(c, 'update', 'settings', key);
  return c.json({ ok: true });
});
