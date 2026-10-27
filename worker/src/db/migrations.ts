// 版本化迁移列表（ONE-347，照 shortlink `apps/worker/src/lib/migrations.ts` 形态）。
//
// 本文件是 schema 的**唯一**可信源：`POST /api/setup` 与 `POST /api/admin/db-upgrade`
// 都经 lib/migrations-runner.ts 的 runMigrations() 执行这里的迁移列表，不再有任何
// 第二份建表定义（原先的 db/schema.ts 已并入本文件）。
//
// 迁移账本表名只能经 types.ts 的 migrationsTable(prefix) 生成。
//
// ── 著述规则（已写入 README / CLAUDE.md，改动前先读）────────────────────────
// 1. 已合并的迁移，**名字与 SQL 都不可修改**（账本按名字记录，改历史会让已部署的库
//    与代码悄悄不一致）。
// 2. 只能在本数组**末尾追加** `schema_v2`、`schema_v3`…。
// 3. 迁移只增不毁：只加表 / 索引 / 列，不删表、不改名、不重写存量数据；
//    破坏性变更须另行立规格（重初始化由用户在合并关口执行，团队不碰线上 D1）。
// 4. `schema_v1` 是当前最终 schema 的**塌缩**：post 无生产数据，历史不再逐级展开。

import { migrationsTable, tbl } from "../types";

export interface Migration {
  name: string;
  sql: string;
}

/** 建账本表的语句（runner 在跑迁移前先执行；IF NOT EXISTS，可重复执行）。 */
export function createMigrationsTableSql(prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS ${migrationsTable(prefix)} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`;
}

/**
 * 按生效前缀参数化的迁移列表：两处 setup 入口共用同一份，杜绝双份维护。
 *
 * 表名 / 索引名一律经 types.ts 的 tbl(prefix, name) 生成——前缀由 TABLE_PREFIX
 * 三态解析给出（`post_` 自带尾部下划线）。
 */
export function getMigrations(prefix: string): Migration[] {
  const t = (name: string) => tbl(prefix, name);

  return [
    {
      name: "schema_v1",
      // 当前最终 schema（SPEC §4）：6 表 + 4 索引，与塌缩前的 SCHEMA_SQL 逐字等价。
      // 鉴权表结构对齐 WorkerHub/eNotify 现行 main；eNotify 独有的 base_currency/theme
      // 等字段不带入，按 SPEC 增补 approval_status / display_name。
      sql: `
CREATE TABLE IF NOT EXISTS ${t("users")} (
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

CREATE TABLE IF NOT EXISTS ${t("user_2fa")} (
  user_id             TEXT PRIMARY KEY REFERENCES ${t("users")}(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS ${t("letters")} (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES ${t("users")}(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_${t("letters")}_status_send_at
  ON ${t("letters")}(status, send_at);
CREATE INDEX IF NOT EXISTS idx_${t("letters")}_user_status
  ON ${t("letters")}(user_id, status);

CREATE TABLE IF NOT EXISTS ${t("letter_recipients")} (
  id         TEXT PRIMARY KEY,
  letter_id  TEXT NOT NULL REFERENCES ${t("letters")}(id) ON DELETE CASCADE,
  contact_id TEXT,
  -- 快照：保存时的姓名/邮箱，不随联系人后续修改变化
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error      TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_${t("letter_recipients")}_letter
  ON ${t("letter_recipients")}(letter_id);

CREATE TABLE IF NOT EXISTS ${t("contacts")} (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES ${t("users")}(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  -- JSON 数组
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_${t("contacts")}_user_email
  ON ${t("contacts")}(user_id, email);

CREATE TABLE IF NOT EXISTS ${t("system_settings")} (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
    },
    {
      name: "schema_v2",
      // waker 回调的执行幂等账本（ONE-566）：SDK 的 executionId 去重表。
      // 建表语句与 waker client `executionLedgerDdl()` 逐列等价，但**在此冻结为字面 SQL**：
      // 迁移一旦合并就不可再改（账本按名字记账，SDK 日后改 DDL 也不得改动本历史项）。
      // 只用于 executionId 去重，不是业务真源；业务防重仍靠 letters 状态抢占。
      sql: `
CREATE TABLE IF NOT EXISTS ${t("waker_executions")} (
  execution_id   TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  job_name       TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  response_json  TEXT,
  claimed_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
`,
    },
  ];
}
