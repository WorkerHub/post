import type { User, User2FA } from "../../types";

// users / user_2fa / system_settings 数据访问（SPEC §3/§8）。
// 表名一律经显式传入的 prefix（getTablePrefix(env) 结果）拼装，禁止裸表名。

export async function createUser(
  db: D1Database,
  prefix: string,
  data: {
    id: string;
    email: string;
    password_hash: string;
    role: string;
    approval_status: "pending" | "approved";
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ${prefix}users (id, email, password_hash, role, is_active, approval_status, display_name, timezone, language, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, '', 'Asia/Shanghai', 'zh', ?, ?)`,
    )
    .bind(
      data.id,
      data.email,
      data.password_hash,
      data.role,
      data.approval_status,
      now,
      now,
    )
    .run();
}

// 单条语句内决定「首个账号即管理员」，与 eNotify 同款原子做法。
// 首个账号同时直接 approved（setup/首账号不等批准）。
export async function createUserFirstIsAdmin(
  db: D1Database,
  prefix: string,
  data: { id: string; email: string; password_hash: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ${prefix}users (id, email, password_hash, role, is_active, approval_status, display_name, timezone, language, created_at, updated_at)
       SELECT ?, ?, ?, CASE WHEN (SELECT COUNT(*) FROM ${prefix}users) = 0 THEN 'admin' ELSE 'user' END, 1,
              CASE WHEN (SELECT COUNT(*) FROM ${prefix}users) = 0 THEN 'approved' ELSE 'pending' END,
              '', 'Asia/Shanghai', 'zh', ?, ?`,
    )
    .bind(data.id, data.email, data.password_hash, now, now)
    .run();
}

export async function findUserByEmail(
  db: D1Database,
  prefix: string,
  email: string,
): Promise<User | null> {
  return db
    .prepare(`SELECT * FROM ${prefix}users WHERE email = ? COLLATE NOCASE`)
    .bind(email.trim())
    .first<User>();
}

export async function findUserById(
  db: D1Database,
  prefix: string,
  id: string,
): Promise<User | null> {
  return db
    .prepare(`SELECT * FROM ${prefix}users WHERE id = ?`)
    .bind(id)
    .first<User>();
}

export async function updateUser(
  db: D1Database,
  prefix: string,
  id: string,
  data: Partial<
    Pick<
      User,
      | "email"
      | "password_hash"
      | "is_active"
      | "approval_status"
      | "display_name"
      | "timezone"
      | "language"
      | "role"
    >
  >,
): Promise<void> {
  const now = new Date().toISOString();
  const allowedCols = new Set([
    "email",
    "password_hash",
    "is_active",
    "approval_status",
    "display_name",
    "timezone",
    "language",
    "role",
  ]);
  const entries = (Object.entries(data) as [string, unknown][]).filter(
    ([col]) => allowedCols.has(col),
  );
  if (entries.length === 0) return;

  const setClauses = entries.map(([col]) => `${col} = ?`).join(", ");
  const values = entries.map(([, val]) => val);

  await db
    .prepare(
      `UPDATE ${prefix}users SET ${setClauses}, updated_at = ? WHERE id = ?`,
    )
    .bind(...values, now, id)
    .run();
}

export async function deleteUser(
  db: D1Database,
  prefix: string,
  id: string,
): Promise<void> {
  await db.prepare(`DELETE FROM ${prefix}users WHERE id = ?`).bind(id).run();
}

export async function listUsers(
  db: D1Database,
  prefix: string,
): Promise<User[]> {
  const result = await db
    .prepare(`SELECT * FROM ${prefix}users ORDER BY created_at DESC`)
    .all<User>();
  return result.results;
}

export async function countUsers(
  db: D1Database,
  prefix: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM ${prefix}users`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// ─── 2FA ──────────────────────────────────────────────────────────────────────

export async function get2FAConfig(
  db: D1Database,
  prefix: string,
  userId: string,
): Promise<User2FA | null> {
  return db
    .prepare(`SELECT * FROM ${prefix}user_2fa WHERE user_id = ?`)
    .bind(userId)
    .first<User2FA>();
}

export async function upsert2FAConfig(
  db: D1Database,
  prefix: string,
  userId: string,
  data: Partial<Omit<User2FA, "user_id" | "updated_at">>,
): Promise<void> {
  const now = new Date().toISOString();

  const columns: string[] = ["user_id"];
  const placeholders: string[] = ["?"];
  const insertValues: unknown[] = [userId];
  const updateClauses: string[] = [];

  const fields: (keyof Omit<User2FA, "user_id" | "updated_at">)[] = [
    "totp_secret",
    "totp_enabled",
    "passkey_credentials",
    "passkey_enabled",
    "email_otp_enabled",
    "preferred_method",
  ];

  for (const field of fields) {
    if (field in data) {
      columns.push(field);
      placeholders.push("?");
      insertValues.push(data[field]);
      updateClauses.push(`${field} = excluded.${field}`);
    }
  }

  columns.push("updated_at");
  placeholders.push("?");
  insertValues.push(now);
  updateClauses.push("updated_at = excluded.updated_at");

  await db
    .prepare(
      `INSERT INTO ${prefix}user_2fa (${columns.join(", ")}) VALUES (${placeholders.join(", ")})
       ON CONFLICT(user_id) DO UPDATE SET ${updateClauses.join(", ")}`,
    )
    .bind(...insertValues)
    .run();
}

// ─── 系统设置 ─────────────────────────────────────────────────────────────────

export async function getSetting(
  db: D1Database,
  prefix: string,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM ${prefix}system_settings WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(
  db: D1Database,
  prefix: string,
  key: string,
  value: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ${prefix}system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now)
    .run();
}

export async function getAllSettings(
  db: D1Database,
  prefix: string,
): Promise<Record<string, string>> {
  const result = await db
    .prepare(`SELECT key, value FROM ${prefix}system_settings`)
    .all<{ key: string; value: string }>();
  return Object.fromEntries(result.results.map((row) => [row.key, row.value]));
}
