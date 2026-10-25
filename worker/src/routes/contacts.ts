import { Hono, type Context } from "hono";
import type { HonoEnv, Contact } from "../types";
import { authMiddleware, getAuthUserId } from "../middleware/auth";
import { isValidEmail } from "../services/email";
import { generateId } from "../core/auth";
import {
  createContact,
  deleteContact,
  findContactByUserEmail,
  getContactById,
  listContactsByUser,
  updateContact,
} from "../db/queries/contacts";

// contacts 业务路由（SPEC §7，ONE-176 冻结契约）：
// GET/POST /api/contacts、GET/PUT/DELETE /api/contacts/:id。
// (user_id, email) 唯一；(GET) 支持 q（姓名/邮箱）与 tag（标签）筛选。

export const contactsRoutes = new Hono<HonoEnv>();
contactsRoutes.use("*", authMiddleware);

const MAX_NAME = 100;
const MAX_NOTES = 5000;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 50;

function serializeContact(contact: Contact): Record<string, unknown> {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(contact.tags);
    if (Array.isArray(parsed)) {
      tags = parsed.map((t) => String(t));
    }
  } catch {
    tags = [];
  }
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    notes: contact.notes,
    tags,
    created_at: contact.created_at,
    updated_at: contact.updated_at,
  };
}

function cleanName(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_NAME) : "";
}

function cleanNotes(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_NOTES) : "";
}

function cleanTags(
  v: unknown,
): { tags?: string[]; error?: string } {
  if (v === undefined || v === null) return { tags: [] };
  if (!Array.isArray(v)) return { error: "标签必须是数组" };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") return { error: "标签必须是字符串" };
    const tag = t.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LEN) {
      return { error: `单个标签最长 ${MAX_TAG_LEN} 字符` };
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) return { error: `最多 ${MAX_TAGS} 个标签` };
  return { tags: out };
}

async function fetchOwnedContact(
  c: Context<HonoEnv>,
  id: string,
): Promise<Contact | null> {
  const contact = await getContactById(c.env.DB, id);
  if (!contact || contact.user_id !== getAuthUserId(c)) return null;
  return contact;
}

// ─── 列表（支持姓名/邮箱搜索 q、标签筛选 tag） ────────────────────────────────

contactsRoutes.get("/", async (c) => {
  const userId = getAuthUserId(c);
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const tag = (c.req.query("tag") || "").trim().toLowerCase();

  let contacts = await listContactsByUser(c.env.DB, userId);

  if (q) {
    contacts = contacts.filter(
      (ct) =>
        ct.name.toLowerCase().includes(q) || ct.email.toLowerCase().includes(q),
    );
  }
  if (tag) {
    contacts = contacts.filter((ct) => {
      try {
        const parsed: unknown = JSON.parse(ct.tags);
        return (
          Array.isArray(parsed) &&
          parsed.some((t) => String(t).toLowerCase() === tag)
        );
      } catch {
        return false;
      }
    });
  }

  return c.json({ contacts: contacts.map(serializeContact) });
});

// ─── 创建 ─────────────────────────────────────────────────────────────────────

contactsRoutes.post("/", async (c) => {
  const userId = getAuthUserId(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    return c.json({ error: "邮箱格式不正确" }, 400);
  }
  const name = cleanName(body.name);
  const notes = cleanNotes(body.notes);
  const tagsRes = cleanTags(body.tags);
  if (tagsRes.error) return c.json({ error: tagsRes.error }, 400);

  const existing = await findContactByUserEmail(c.env.DB, userId, email);
  if (existing) return c.json({ error: "该邮箱已在联系人中" }, 409);

  const id = generateId();
  await createContact(c.env.DB, {
    id,
    user_id: userId,
    name,
    email,
    notes,
    tags: JSON.stringify(tagsRes.tags ?? []),
  });

  const created = await getContactById(c.env.DB, id);
  return c.json(serializeContact(created!), 201);
});

// ─── 详情 ─────────────────────────────────────────────────────────────────────

contactsRoutes.get("/:id", async (c) => {
  const contact = await fetchOwnedContact(c, c.req.param("id"));
  if (!contact) return c.json({ error: "Not found" }, 404);
  return c.json(serializeContact(contact));
});

// ─── 更新 ─────────────────────────────────────────────────────────────────────

contactsRoutes.put("/:id", async (c) => {
  const userId = getAuthUserId(c);
  const id = c.req.param("id");
  const contact = await fetchOwnedContact(c, id);
  if (!contact) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    return c.json({ error: "邮箱格式不正确" }, 400);
  }

  const existing = await findContactByUserEmail(c.env.DB, userId, email);
  if (existing && existing.id !== id) {
    return c.json({ error: "该邮箱已在联系人中" }, 409);
  }

  const tagsRes = cleanTags(body.tags);
  if (tagsRes.error) return c.json({ error: tagsRes.error }, 400);

  await updateContact(c.env.DB, id, {
    name: cleanName(body.name),
    email,
    notes: cleanNotes(body.notes),
    tags: JSON.stringify(tagsRes.tags ?? []),
  });

  const updated = await getContactById(c.env.DB, id);
  return c.json(serializeContact(updated!));
});

// ─── 删除 ─────────────────────────────────────────────────────────────────────

contactsRoutes.delete("/:id", async (c) => {
  const contact = await fetchOwnedContact(c, c.req.param("id"));
  if (!contact) return c.json({ error: "Not found" }, 404);
  await deleteContact(c.env.DB, contact.id);
  return c.json({ success: true });
});
