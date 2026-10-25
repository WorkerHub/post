import type { Contact } from "../../types";

// contacts 数据访问（SPEC §7）。归属过滤由路由层用 user_id 完成。

export interface NewContact {
  id: string;
  user_id: string;
  name: string;
  email: string;
  notes: string;
  tags: string;
}

const CONTACT_UPDATE_COLS = new Set(["name", "email", "notes", "tags"]);

export async function listContactsByUser(
  db: D1Database,
  userId: string,
): Promise<Contact[]> {
  const result = await db
    .prepare(
      `SELECT * FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .bind(userId)
    .all<Contact>();
  return result.results;
}

export async function getContactById(
  db: D1Database,
  id: string,
): Promise<Contact | null> {
  return db
    .prepare(`SELECT * FROM contacts WHERE id = ?`)
    .bind(id)
    .first<Contact>();
}

export async function findContactByUserEmail(
  db: D1Database,
  userId: string,
  email: string,
): Promise<Contact | null> {
  return db
    .prepare(
      `SELECT * FROM contacts WHERE user_id = ? AND email = ? COLLATE NOCASE`,
    )
    .bind(userId, email.trim().toLowerCase())
    .first<Contact>();
}

export async function createContact(
  db: D1Database,
  data: NewContact,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO contacts (id, user_id, name, email, notes, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(data.id, data.user_id, data.name, data.email, data.notes, data.tags, now, now)
    .run();
}

export async function updateContact(
  db: D1Database,
  id: string,
  data: Partial<Pick<Contact, "name" | "email" | "notes" | "tags">>,
): Promise<void> {
  const now = new Date().toISOString();
  const entries = (Object.entries(data) as [string, unknown][]).filter(
    ([col, val]) => CONTACT_UPDATE_COLS.has(col) && val !== undefined,
  );
  if (entries.length === 0) return;

  const setClauses = entries.map(([col]) => `${col} = ?`).join(", ");
  const values = entries.map(([, val]) => val);

  await db
    .prepare(`UPDATE contacts SET ${setClauses}, updated_at = ? WHERE id = ?`)
    .bind(...values, now, id)
    .run();
}

export async function deleteContact(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM contacts WHERE id = ?`).bind(id).run();
}
