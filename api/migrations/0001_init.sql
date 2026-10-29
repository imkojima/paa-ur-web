-- PAA-UR 初始 schema（自 paa-web 0001–0021 合併而來，移除會員／入會／相簿／關於我們等公會專屬資料表）。
-- 新專案沒有既有資料庫，故以單一 migration 起始；之後的變更一律新增 0002 起的檔案，不要回頭改這支。

-- ── 後台管理者 ───────────────────────────────────────────────
CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('superadmin','editor','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_login_at TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 帳號不分大小寫（見 auth.ts 的 normUsername）
CREATE UNIQUE INDEX idx_admin_users_username_nocase ON admin_users(username COLLATE NOCASE);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER REFERENCES admin_users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  changes TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 公告 ─────────────────────────────────────────────────────
CREATE TABLE announcement_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT,
  scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public','member')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','member')),
  category_id INTEGER NOT NULL REFERENCES announcement_categories(id),
  title TEXT NOT NULL,
  excerpt TEXT,
  body TEXT,                 -- HTML（TinyMCE）或舊版區塊 JSON
  publish_date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
  show_in_list INTEGER NOT NULL DEFAULT 1 CHECK (show_in_list IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','archived')),
  published_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES admin_users(id),
  updated_by INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_announcements_list ON announcements(visibility, status, is_pinned, publish_date);
CREATE INDEX idx_announcements_category ON announcements(category_id);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL DEFAULT 'announcement' CHECK (owner_type IN ('announcement')),
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'pdf' CHECK (type IN ('pdf','doc','xls','img','other')),
  access TEXT NOT NULL DEFAULT 'public' CHECK (access IN ('public','member')),
  file_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attachments_owner ON attachments(owner_type, owner_id);

-- ── 檔案下載 ─────────────────────────────────────────────────
CREATE TABLE document_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  access_scope TEXT NOT NULL DEFAULT 'both' CHECK (access_scope IN ('public','member','both')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  publish_date TEXT,
  category_id INTEGER NOT NULL REFERENCES document_categories(id),
  access TEXT NOT NULL DEFAULT 'public' CHECK (access IN ('public','member')),
  file_path TEXT,
  size_bytes INTEGER,
  type TEXT NOT NULL DEFAULT 'pdf' CHECK (type IN ('pdf','doc','xls','img','other')),
  download_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_documents_cat ON documents(category_id, access);

-- ── 首頁與站台 ───────────────────────────────────────────────
CREATE TABLE hero_slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  background_image TEXT,
  eyebrow TEXT,
  title TEXT NOT NULL,
  description TEXT,
  buttons TEXT,              -- JSON
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE friend_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE home_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "key" TEXT NOT NULL UNIQUE,
  title TEXT,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,     -- JSON
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 隱私權政策／網站使用條款：固定兩筆，後台只能編輯不能新增刪除（見 admin.ts 的 LEGAL_KEYS）
CREATE TABLE legal_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "key" TEXT NOT NULL UNIQUE CHECK ("key" IN ('privacy','terms')),
  title TEXT NOT NULL,
  title_en TEXT,
  updated_date TEXT,
  blocks TEXT NOT NULL,
  file_key TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 頁面管理／選單（尚未接上前後台，下一階段實作）────────────────
CREATE TABLE pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  title_en TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'builtin' CHECK (link_type IN ('builtin','page','url')),
  target TEXT NOT NULL,
  parent_id INTEGER REFERENCES menu_items(id),
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0,1)),
  is_accent INTEGER NOT NULL DEFAULT 0 CHECK (is_accent IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ── 必要初始資料（可由後台再維護）──────────────────────────────
INSERT INTO announcement_categories (name, color, scope, sort_order) VALUES
  ('一般公告', '#1f3a5f', 'public', 1),
  ('新聞稿', '#2d6a4f', 'public', 2),
  ('活動訊息', '#b8924a', 'public', 3);

INSERT INTO home_sections ("key", title, is_visible, sort_order) VALUES
  ('hero', '首頁輪播', 1, 1),
  ('news', '最新公告', 1, 2),
  ('downloads', '檔案下載', 1, 3),
  ('friends', '相關連結', 1, 4);

INSERT INTO settings ("key", "value") VALUES
  ('publisher_default', '"承辦單位"'),
  ('contact', '{"address":"","tel":"","fax":"","email":""}');

INSERT INTO legal_pages ("key", title, title_en, updated_date, blocks) VALUES
  ('privacy', '隱私權政策', 'PRIVACY POLICY', date('now'), '[]'),
  ('terms', '網站使用條款', 'TERMS OF USE', date('now'), '[]');
