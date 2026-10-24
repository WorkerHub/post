// post 时光邮局 schema v1（SPEC §4，本文件落地后冻结）。
// 鉴权表结构对齐 WorkerHub/eNotify 现行 main；
// eNotify 独有的 base_currency/theme 等字段不带入，按 SPEC 增补 approval_status / display_name。
//
// 同一份 SQL 同时用于两处，test/schema.test.ts 保证两者一致：
// - migrations/0001_init.sql：wrangler d1 migrations（本地/线上迁移）
// - setup 接口内联建表（全新部署初始化）

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user',
  is_active       INTEGER NOT NULL DEFAULT 1,
  -- 开放注册但默认待批准（SPEC §3）：管理员批准（approved）后才能登录使用
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved')),
  -- 公开信墙发信人显示名；空则显示「一位朋友」
  display_name    TEXT NOT NULL DEFAULT '',
  timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  language        TEXT NOT NULL DEFAULT 'zh',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_2fa (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret         TEXT,
  totp_enabled        INTEGER NOT NULL DEFAULT 0,
  passkey_credentials TEXT,
  passkey_enabled     INTEGER NOT NULL DEFAULT 0,
  email_otp_enabled   INTEGER NOT NULL DEFAULT 0,
  preferred_method    TEXT,
  updated_at          TEXT NOT NULL
);

-- 会话表：与 eNotify 相同的 HttpOnly Cookie + JWT（access 24h / refresh 7d）机制，
-- refresh jti 与 sid 存 KV（rt: / ss: / sessions:），不落 D1——对齐 eNotify 现行做法。

CREATE TABLE IF NOT EXISTS letters (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  body_html  TEXT NOT NULL DEFAULT '',
  -- TipTap 文档 JSON，与 body_html 双存
  body_json  TEXT NOT NULL DEFAULT '',
  -- UTC ISO；草稿可空
  send_at    TEXT,
  timezone   TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  is_public  INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_letters_status_send_at
  ON letters(status, send_at);
CREATE INDEX IF NOT EXISTS idx_letters_user_status
  ON letters(user_id, status);

CREATE TABLE IF NOT EXISTS letter_recipients (
  id         TEXT PRIMARY KEY,
  letter_id  TEXT NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  contact_id TEXT,
  -- 快照：保存时的姓名/邮箱，不随联系人后续修改变化
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error      TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_letter_recipients_letter
  ON letter_recipients(letter_id);

CREATE TABLE IF NOT EXISTS contacts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  -- JSON 数组
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_email
  ON contacts(user_id, email);

CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
