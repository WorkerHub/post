import { Hono, type Context } from "hono";
import type { HonoEnv, Letter, LetterRecipient } from "../types";
import { getTablePrefix, tables } from "../types";
import { authMiddleware, getAuthUserId } from "../middleware/auth";
import { isValidEmail } from "../services/email";
import { sanitizeBodyHtml } from "../services/sanitize";
import { generateId } from "../core/auth";
import {
  countRecipientsByLetter,
  countSentRecipients,
  createLetter,
  deleteLetter,
  getLetterById,
  listLettersByUser,
  listRecipientsByLetter,
  resetFailedRecipientsForResend,
  updateLetter,
  type LetterUpdate,
} from "../db/queries/letters";
import { getContactById } from "../db/queries/contacts";

// letters 业务路由（SPEC §5/§6，ONE-176 冻结契约）：
// GET/POST /api/letters、GET/PUT/DELETE /api/letters/:id、PATCH /api/letters/:id、
// POST /api/letters/:id/schedule|cancel|resend|draft。
//
// 状态机（SPEC §5，ONE-176 复评后冻结）：
//   draft → schedule → scheduled → cron 抢占 → sending → sent / failed
//   scheduled → draft（撤回草稿）｜cancelled（取消）；failed → resend → scheduled（attempts 归零）
//   cancelled → draft（前端③契约：已取消可回草稿再编辑）
//
// 操作边界（不变量）：
// - 内容/收件人编辑（PUT/PATCH 非 is_public 字段）：draft，或 scheduled 且无已投递收件人（status='sent'），
//   或 cancelled 且无已投递收件人（保存后回 draft）。
// - scheduled 不变量：任何使信件处于 scheduled 的写入，收件人数量必须 >0 且 send_at 必须晚于当前时间，
//   杜绝「空收件人幽灵发送 / 过去时间提前触发 / null send_at 死锁」。
// - 已有 sent 收件人的信严禁重写收件人（防重复投递）；只能 cancel（若仍 scheduled）或等 cron 收尾。

export const lettersRoutes = new Hono<HonoEnv>();
lettersRoutes.use("*", authMiddleware);

const MAX_RECIPIENTS = 100;
const MAX_TITLE = 500;
const VALID_STATUSES = new Set([
  "draft",
  "scheduled",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);

interface ResolvedRecipient {
  contact_id: string | null;
  name: string;
  email: string;
}

interface RecipientInput {
  contact_id?: string | null;
  name?: string;
  email?: string;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function serializeLetter(
  letter: Letter,
  recipients: LetterRecipient[],
): Record<string, unknown> {
  return {
    id: letter.id,
    title: letter.title,
    body_html: letter.body_html,
    body_json: letter.body_json,
    send_at: letter.send_at,
    timezone: letter.timezone,
    is_public: !!letter.is_public,
    status: letter.status,
    attempts: letter.attempts,
    last_error: letter.last_error,
    sent_at: letter.sent_at,
    created_at: letter.created_at,
    updated_at: letter.updated_at,
    recipients: recipients.map((r) => ({
      contact_id: r.contact_id,
      name: r.name,
      email: r.email,
    })),
  };
}

/** 归属校验：非本人数据一律 404（不泄露存在性）。 */
async function fetchOwnedLetter(
  c: Context<HonoEnv>,
  id: string,
): Promise<Letter | null> {
  const letter = await getLetterById(c.env.DB, getTablePrefix(c.env), id);
  if (!letter || letter.user_id !== getAuthUserId(c)) return null;
  return letter;
}

/** 是否允许编辑内容/收件人（is_public 开关不在此列）。cancelled 可回 draft 再编辑（前端③契约）。 */
function isEditableStatus(letter: Letter): boolean {
  return (
    letter.status === "draft" ||
    letter.status === "scheduled" ||
    letter.status === "cancelled"
  );
}

/**
 * 防重复投递核心边界：只要信件在 letter_recipients 中存在 status='sent' 的记录，
 * 无论当前是 scheduled 还是 cancelled（或任何可编辑状态），均禁止内容/收件人编辑与回退草稿。
 * （部分投递成功后信件可能被 cancel 或 failed→resend→cancel，此时仍带 sent 收件人。）
 */
async function hasDeliveredRecipients(
  c: Context<HonoEnv>,
  letterId: string,
): Promise<boolean> {
  return (await countSentRecipients(c.env.DB, getTablePrefix(c.env), letterId)) > 0;
}

/** scheduled 不变量：收件人非空 + send_at 晚于当前时间。返回 null 表示通过。 */
function scheduledInvariantError(
  recipientCount: number,
  sendAt: string | null,
): string | null {
  if (recipientCount === 0) return "请至少添加一位收件人";
  if (!sendAt || new Date(sendAt).getTime() <= Date.now()) {
    return "送达时间须晚于当前时间";
  }
  return null;
}

/** 校验并解析收件人快照：联系人引用读库落快照，手填校验格式，按邮箱去重。 */
async function resolveRecipients(
  db: D1Database,
  prefix: string,
  userId: string,
  input: unknown,
): Promise<
  | { recipients?: ResolvedRecipient[]; error?: string }
> {
  if (input === undefined || input === null) return { recipients: [] };
  if (!Array.isArray(input)) {
    return { error: "收件人必须是数组" };
  }
  if (input.length > MAX_RECIPIENTS) {
    return { error: `收件人最多 ${MAX_RECIPIENTS} 位` };
  }

  const seen = new Set<string>();
  const recipients: ResolvedRecipient[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item === null) {
      return { error: "收件人格式不正确" };
    }
    const r = item as RecipientInput;

    let contact_id: string | null = null;
    let name = "";
    let email = "";

    if (typeof r.contact_id === "string" && r.contact_id) {
      // 联系人引用：读库落快照（name/email 以联系人当前记录为准，不随后续修改变化）
      const contact = await getContactById(db, prefix, r.contact_id);
      if (!contact || contact.user_id !== userId) {
        return { error: "联系人不存在" };
      }
      contact_id = contact.id;
      name = contact.name;
      email = contact.email;
    } else {
      // 手填邮箱：name 可空
      name = typeof r.name === "string" ? r.name.trim().slice(0, 200) : "";
      email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
    }

    if (!isValidEmail(email)) {
      return { error: "收件人邮箱格式不正确" };
    }

    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ contact_id, name, email });
  }

  return { recipients };
}

/** 从请求体解析可编辑字段；returns 里 undefined 的字段表示未提供（供 PATCH 用）。 */
async function parseLetterFields(
  c: Context<HonoEnv>,
  body: Record<string, unknown>,
  userId: string,
): Promise<
  | { error: Response }
  | {
      title?: string;
      body_html?: string;
      body_json?: string;
      send_at?: string | null;
      timezone?: string;
      is_public?: number;
      recipients?: ResolvedRecipient[];
    }
> {
  const out: {
    title?: string;
    body_html?: string;
    body_json?: string;
    send_at?: string | null;
    timezone?: string;
    is_public?: number;
    recipients?: ResolvedRecipient[];
  } = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      return { error: c.json({ error: "标题格式不正确" }, 400) };
    }
    out.title = body.title.trim().slice(0, MAX_TITLE);
  }
  if (body.body_html !== undefined) {
    const html = typeof body.body_html === "string" ? body.body_html : "";
    out.body_html = sanitizeBodyHtml(html);
  }
  if (body.body_json !== undefined) {
    out.body_json =
      typeof body.body_json === "string"
        ? body.body_json
        : typeof body.body_json === "object" && body.body_json !== null
          ? JSON.stringify(body.body_json)
          : "";
  }
  if (body.send_at !== undefined) {
    if (body.send_at === null || body.send_at === "") {
      out.send_at = null;
    } else if (
      typeof body.send_at === "string" &&
      !Number.isNaN(new Date(body.send_at).getTime())
    ) {
      out.send_at = new Date(body.send_at).toISOString();
    } else {
      return { error: c.json({ error: "送达时间格式不正确" }, 400) };
    }
  }
  if (body.timezone !== undefined) {
    const tz =
      typeof body.timezone === "string" && body.timezone.trim()
        ? body.timezone.trim()
        : "Asia/Shanghai";
    if (!isValidTimezone(tz)) {
      return { error: c.json({ error: "时区不正确" }, 400) };
    }
    out.timezone = tz;
  }
  if (body.is_public !== undefined) {
    out.is_public = body.is_public ? 1 : 0;
  }
  if (body.recipients !== undefined) {
    const resolved = await resolveRecipients(
      c.env.DB,
      getTablePrefix(c.env),
      userId,
      body.recipients,
    );
    if (resolved.error) {
      return {
        error: c.json({ error: resolved.error }, 400),
      };
    }
    out.recipients = resolved.recipients ?? [];
  }

  return out;
}

/** 全量替换收件人快照（单原子 batch，杜绝半途失败留下部分缺失）。 */
async function replaceRecipients(
  c: Context<HonoEnv>,
  letterId: string,
  recipients: ResolvedRecipient[],
): Promise<void> {
  const T = tables(c.env);
  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare(
      `DELETE FROM ${T.letter_recipients} WHERE letter_id = ?`,
    ).bind(letterId),
    ...recipients.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO ${T.letter_recipients} (id, letter_id, contact_id, name, email, status, error, sent_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
      ).bind(generateId(), letterId, r.contact_id, r.name, r.email, now),
    ),
  ];
  await c.env.DB.batch(statements);
}

async function respondWithLetter(
  c: Context<HonoEnv>,
  id: string,
  status: 200 | 201 = 200,
): Promise<Response> {
  const prefix = getTablePrefix(c.env);
  const letter = await getLetterById(c.env.DB, prefix, id);
  const recipients = await listRecipientsByLetter(c.env.DB, prefix, id);
  return c.json(serializeLetter(letter!, recipients), status);
}

// ─── 列表 ─────────────────────────────────────────────────────────────────────

lettersRoutes.get("/", async (c) => {
  const userId = getAuthUserId(c);
  const prefix = getTablePrefix(c.env);
  const statusParam = c.req.query("status");
  if (statusParam && !VALID_STATUSES.has(statusParam)) {
    return c.json({ error: "Invalid status" }, 400);
  }
  const letters = await listLettersByUser(c.env.DB, prefix, userId, statusParam);
  const out: Record<string, unknown>[] = [];
  for (const letter of letters) {
    const recipients = await listRecipientsByLetter(c.env.DB, prefix, letter.id);
    out.push(serializeLetter(letter, recipients));
  }
  return c.json({ letters: out });
});

// ─── 创建（草稿） ─────────────────────────────────────────────────────────────

lettersRoutes.post("/", async (c) => {
  const userId = getAuthUserId(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const parsed = await parseLetterFields(c, body, userId);
  if ("error" in parsed) return parsed.error;

  const id = generateId();
  await createLetter(c.env.DB, getTablePrefix(c.env), {
    id,
    user_id: userId,
    title: parsed.title ?? "",
    body_html: parsed.body_html ?? "",
    body_json: parsed.body_json ?? "",
    send_at: parsed.send_at ?? null,
    timezone: parsed.timezone ?? "Asia/Shanghai",
    is_public: parsed.is_public ?? 0,
  });

  await replaceRecipients(c, id, parsed.recipients ?? []);
  return respondWithLetter(c, id, 201);
});

// ─── 详情 ─────────────────────────────────────────────────────────────────────

lettersRoutes.get("/:id", async (c) => {
  const letter = await fetchOwnedLetter(c, c.req.param("id"));
  if (!letter) return c.json({ error: "Not found" }, 404);
  return respondWithLetter(c, letter.id);
});

// ─── 全量更新（寄出前可编辑，状态保持不变 + scheduled 不变量） ──────────────

lettersRoutes.put("/:id", async (c) => {
  const userId = getAuthUserId(c);
  const id = c.req.param("id");
  const letter = await fetchOwnedLetter(c, id);
  if (!letter) return c.json({ error: "Not found" }, 404);

  if (!isEditableStatus(letter)) {
    return c.json({ error: "寄出后不可再编辑" }, 409);
  }
  if (await hasDeliveredRecipients(c, id)) {
    return c.json({ error: "已开始投递的信不可再编辑" }, 409);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const parsed = await parseLetterFields(c, body, userId);
  if ("error" in parsed) return parsed.error;

  const targetRecipients = parsed.recipients ?? [];
  const targetSendAt = parsed.send_at ?? null;
  // cancelled 保存后回 draft（前端③契约：已取消可再编辑）；其余状态保持不变。
  const targetStatus = letter.status === "cancelled" ? "draft" : letter.status;

  // scheduled 不变量：编辑后仍为 scheduled，收件人必须非空且 send_at 未来。
  if (targetStatus === "scheduled") {
    const invErr = scheduledInvariantError(targetRecipients.length, targetSendAt);
    if (invErr) return c.json({ error: invErr }, 400);
  }

  const updates: LetterUpdate = {
    title: parsed.title ?? "",
    body_html: parsed.body_html ?? "",
    body_json: parsed.body_json ?? "",
    send_at: targetSendAt,
    timezone: parsed.timezone ?? "Asia/Shanghai",
    is_public: parsed.is_public ?? 0,
  };
  if (targetStatus !== letter.status) updates.status = targetStatus;
  await updateLetter(c.env.DB, getTablePrefix(c.env), id, updates);

  await replaceRecipients(c, id, targetRecipients);

  return respondWithLetter(c, id);
});

// ─── 部分更新（is_public 任意状态可切；其他字段同 PUT 边界 + 不变量） ────────

lettersRoutes.patch("/:id", async (c) => {
  const userId = getAuthUserId(c);
  const id = c.req.param("id");
  const letter = await fetchOwnedLetter(c, id);
  if (!letter) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const contentKeys = [
    "title",
    "body_html",
    "body_json",
    "send_at",
    "timezone",
    "recipients",
  ];
  const hasContentEdit = contentKeys.some((k) => body[k] !== undefined);
  if (hasContentEdit) {
    if (!isEditableStatus(letter)) {
      return c.json({ error: "寄出后不可再编辑" }, 409);
    }
    if (await hasDeliveredRecipients(c, id)) {
      return c.json({ error: "已开始投递的信不可再编辑" }, 409);
    }
  }

  const parsed = await parseLetterFields(c, body, userId);
  if ("error" in parsed) return parsed.error;

  // 计算编辑后的有效值，用于 scheduled 不变量校验（先校验后写入，避免留下脏状态）。
  // cancelled 内容编辑后回 draft（前端③契约）；纯 is_public 开关保持原状态。
  const targetStatus =
    hasContentEdit && letter.status === "cancelled" ? "draft" : letter.status;
  const effectiveSendAt =
    parsed.send_at !== undefined ? parsed.send_at : letter.send_at;
  let effectiveRecipientCount: number | null = null;
  if (parsed.recipients !== undefined) {
    effectiveRecipientCount = parsed.recipients.length;
  }

  if (targetStatus === "scheduled") {
    const count =
      effectiveRecipientCount ??
      (await countRecipientsByLetter(c.env.DB, getTablePrefix(c.env), id));
    const invErr = scheduledInvariantError(count, effectiveSendAt);
    if (invErr) return c.json({ error: invErr }, 400);
  }

  const updates: LetterUpdate = {};
  if (parsed.title !== undefined) updates.title = parsed.title;
  if (parsed.body_html !== undefined) updates.body_html = parsed.body_html;
  if (parsed.body_json !== undefined) updates.body_json = parsed.body_json;
  if (parsed.send_at !== undefined) updates.send_at = parsed.send_at;
  if (parsed.timezone !== undefined) updates.timezone = parsed.timezone;
  if (parsed.is_public !== undefined) updates.is_public = parsed.is_public;
  if (targetStatus !== letter.status) updates.status = targetStatus;

  if (Object.keys(updates).length > 0) {
    await updateLetter(c.env.DB, getTablePrefix(c.env), id, updates);
  }

  if (parsed.recipients !== undefined) {
    await replaceRecipients(c, id, parsed.recipients);
  }

  return respondWithLetter(c, id);
});

// ─── 删除（sending 中禁止，其余状态级联删除收件人） ──────────────────────────

lettersRoutes.delete("/:id", async (c) => {
  const letter = await fetchOwnedLetter(c, c.req.param("id"));
  if (!letter) return c.json({ error: "Not found" }, 404);
  if (letter.status === "sending") {
    return c.json({ error: "发送中，暂不可删除" }, 409);
  }
  await deleteLetter(c.env.DB, getTablePrefix(c.env), letter.id);
  return c.json({ success: true });
});

// ─── 状态流转 ─────────────────────────────────────────────────────────────────

lettersRoutes.post("/:id/schedule", async (c) => {
  const id = c.req.param("id");
  const letter = await fetchOwnedLetter(c, id);
  if (!letter) return c.json({ error: "Not found" }, 404);

  if (letter.status !== "draft" && letter.status !== "scheduled") {
    return c.json({ error: "当前状态不可定时寄出" }, 409);
  }

  const recipientCount = await countRecipientsByLetter(
    c.env.DB,
    getTablePrefix(c.env),
    id,
  );
  const invErr = scheduledInvariantError(recipientCount, letter.send_at);
  if (invErr) return c.json({ error: invErr }, 400);

  if (letter.status === "draft") {
    await updateLetter(c.env.DB, getTablePrefix(c.env), id, {
      status: "scheduled",
      attempts: 0,
      last_error: null,
    });
  }

  return respondWithLetter(c, id);
});

// scheduled/cancelled → draft（撤回草稿）：均需无已投递收件人（防重复投递）。
lettersRoutes.post("/:id/draft", async (c) => {
  const id = c.req.param("id");
  const letter = await fetchOwnedLetter(c, id);
  if (!letter) return c.json({ error: "Not found" }, 404);

  if (letter.status === "draft") {
    return respondWithLetter(c, id);
  }
  if (letter.status !== "scheduled" && letter.status !== "cancelled") {
    return c.json({ error: "仅待寄出或已取消的信可撤回草稿" }, 409);
  }
  if (await hasDeliveredRecipients(c, id)) {
    return c.json({ error: "已开始投递的信不可撤回草稿" }, 409);
  }

  await updateLetter(c.env.DB, getTablePrefix(c.env), id, { status: "draft", last_error: null });
  return respondWithLetter(c, id);
});

lettersRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const letter = await fetchOwnedLetter(c, id);
  if (!letter) return c.json({ error: "Not found" }, 404);

  if (letter.status === "cancelled") {
    return respondWithLetter(c, id);
  }
  if (letter.status !== "scheduled") {
    return c.json({ error: "仅待寄出的信可取消" }, 409);
  }

  await updateLetter(c.env.DB, getTablePrefix(c.env), id, { status: "cancelled", last_error: null });
  return respondWithLetter(c, id);
});

lettersRoutes.post("/:id/resend", async (c) => {
  const id = c.req.param("id");
  const letter = await fetchOwnedLetter(c, id);
  if (!letter) return c.json({ error: "Not found" }, 404);

  if (letter.status !== "failed") {
    return c.json({ error: "仅发送失败的信可重发" }, 409);
  }

  // attempts 归零回 scheduled；只补发失败的收件人（已成功的保留，不重复投递）。
  await updateLetter(c.env.DB, getTablePrefix(c.env), id, {
    status: "scheduled",
    attempts: 0,
    last_error: null,
  });
  await resetFailedRecipientsForResend(c.env.DB, getTablePrefix(c.env), id);

  return respondWithLetter(c, id);
});
