import type { Letter, LetterRecipient } from "../../types";

// letters / letter_recipients 数据访问（SPEC §4/§5）。
// 归属过滤一律由路由层用 user_id 完成，这里只提供按 id / user_id 的查询原语。
// 表名一律经显式传入的 prefix（getTablePrefix(env) 结果）拼装，禁止裸表名。

export interface NewLetter {
  id: string;
  user_id: string;
  title: string;
  body_html: string;
  body_json: string;
  send_at: string | null;
  timezone: string;
  is_public: number;
}

export type LetterUpdate = Partial<{
  title: string;
  body_html: string;
  body_json: string;
  send_at: string | null;
  timezone: string;
  status: string;
  is_public: number;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
}>;

const LETTER_UPDATE_COLS = new Set([
  "title",
  "body_html",
  "body_json",
  "send_at",
  "timezone",
  "status",
  "is_public",
  "attempts",
  "last_error",
  "sent_at",
]);

export async function listLettersByUser(
  db: D1Database,
  prefix: string,
  userId: string,
  status?: string,
): Promise<Letter[]> {
  const sql = status
    ? `SELECT * FROM ${prefix}letters WHERE user_id = ? AND status = ? ORDER BY updated_at DESC, id ASC`
    : `SELECT * FROM ${prefix}letters WHERE user_id = ? ORDER BY updated_at DESC, id ASC`;
  const stmt = status
    ? db.prepare(sql).bind(userId, status)
    : db.prepare(sql).bind(userId);
  const result = await stmt.all<Letter>();
  return result.results;
}

export async function getLetterById(
  db: D1Database,
  prefix: string,
  id: string,
): Promise<Letter | null> {
  return db
    .prepare(`SELECT * FROM ${prefix}letters WHERE id = ?`)
    .bind(id)
    .first<Letter>();
}

export async function createLetter(
  db: D1Database,
  prefix: string,
  data: NewLetter,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ${prefix}letters (id, user_id, title, body_html, body_json, send_at, timezone, status, is_public, attempts, last_error, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 0, NULL, NULL, ?, ?)`,
    )
    .bind(
      data.id,
      data.user_id,
      data.title,
      data.body_html,
      data.body_json,
      data.send_at,
      data.timezone,
      data.is_public,
      now,
      now,
    )
    .run();
}

export async function updateLetter(
  db: D1Database,
  prefix: string,
  id: string,
  data: LetterUpdate,
): Promise<void> {
  const now = new Date().toISOString();
  const entries = (Object.entries(data) as [string, unknown][]).filter(
    ([col, val]) => LETTER_UPDATE_COLS.has(col) && val !== undefined,
  );
  if (entries.length === 0) return;

  const setClauses = entries.map(([col]) => `${col} = ?`).join(", ");
  const values = entries.map(([, val]) => val);

  await db
    .prepare(
      `UPDATE ${prefix}letters SET ${setClauses}, updated_at = ? WHERE id = ?`,
    )
    .bind(...values, now, id)
    .run();
}

export async function deleteLetter(
  db: D1Database,
  prefix: string,
  id: string,
): Promise<void> {
  // 双重防御：显式清理收件人快照，不依赖 D1 连接的 PRAGMA foreign_keys 级联。
  await db.batch([
    db.prepare(`DELETE FROM ${prefix}letter_recipients WHERE letter_id = ?`).bind(id),
    db.prepare(`DELETE FROM ${prefix}letters WHERE id = ?`).bind(id),
  ]);
}

// ─── 收件人快照 ───────────────────────────────────────────────────────────────

export async function listRecipientsByLetter(
  db: D1Database,
  prefix: string,
  letterId: string,
): Promise<LetterRecipient[]> {
  const result = await db
    .prepare(
      `SELECT * FROM ${prefix}letter_recipients WHERE letter_id = ? ORDER BY id ASC`,
    )
    .bind(letterId)
    .all<LetterRecipient>();
  return result.results;
}

export async function countRecipientsByLetter(
  db: D1Database,
  prefix: string,
  letterId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as count FROM ${prefix}letter_recipients WHERE letter_id = ?`,
    )
    .bind(letterId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** 已投递成功的收件人数（>0 表示已部分/全部投递，禁止再重写收件人以防重复投递）。 */
export async function countSentRecipients(
  db: D1Database,
  prefix: string,
  letterId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as count FROM ${prefix}letter_recipients WHERE letter_id = ? AND status = 'sent'`,
    )
    .bind(letterId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function deleteRecipientsByLetter(
  db: D1Database,
  prefix: string,
  letterId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${prefix}letter_recipients WHERE letter_id = ?`)
    .bind(letterId)
    .run();
}

export interface NewRecipient {
  id: string;
  letter_id: string;
  contact_id: string | null;
  name: string;
  email: string;
}

export async function insertRecipient(
  db: D1Database,
  prefix: string,
  data: NewRecipient,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ${prefix}letter_recipients (id, letter_id, contact_id, name, email, status, error, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
    )
    .bind(data.id, data.letter_id, data.contact_id, data.name, data.email, now)
    .run();
}

/** 手动重发：把失败的收件人重置为 pending（已成功的收件人保留，不重复投递）。 */
export async function resetFailedRecipientsForResend(
  db: D1Database,
  prefix: string,
  letterId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${prefix}letter_recipients SET status = 'pending', error = NULL, sent_at = NULL
       WHERE letter_id = ? AND status = 'failed'`,
    )
    .bind(letterId)
    .run();
}

// ─── 公开信墙 ─────────────────────────────────────────────────────────────────

export interface PublicLetterRow {
  id: string;
  title: string;
  body_html: string;
  send_at: string | null;
  sent_at: string | null;
  created_at: string;
  author_name: string;
  /** 首个收件人邮箱（打码处理发生在路由层，绝不直接返回原文） */
  recipient_email: string | null;
}

export async function listPublicLetters(
  db: D1Database,
  prefix: string,
): Promise<PublicLetterRow[]> {
  const result = await db
    .prepare(
      `SELECT l.id, l.title, l.body_html, l.send_at, l.sent_at, l.created_at,
              u.display_name AS author_name,
              (SELECT r.email FROM ${prefix}letter_recipients r WHERE r.letter_id = l.id ORDER BY r.id ASC LIMIT 1) AS recipient_email
       FROM ${prefix}letters l
       JOIN ${prefix}users u ON u.id = l.user_id
       WHERE l.is_public = 1 AND l.status IN ('scheduled', 'sent')
       ORDER BY COALESCE(l.sent_at, l.send_at) DESC
       LIMIT 100`,
    )
    .all<PublicLetterRow>();
  return result.results;
}

export async function countSentLetters(
  db: D1Database,
  prefix: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as count FROM ${prefix}letters WHERE status = 'sent'`,
    )
    .first<{ count: number }>();
  return row?.count ?? 0;
}
