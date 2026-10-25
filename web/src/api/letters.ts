// letters 冻结契约（ONE-175，与后端④对齐，不得私下变更）：
// GET/POST /api/letters、GET/PUT/DELETE /api/letters/:id、
// POST /api/letters/:id/schedule|cancel|resend、PATCH /api/letters/:id
// 保存载荷：{ title, body_html, body_json, send_at, timezone, is_public, recipients: [{ contact_id?, name?, email }] }

export type LetterStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

/** 收件人快照：contact_id 指向联系人（可空），name/email 为保存时快照。 */
export interface LetterRecipient {
  contact_id: string | null;
  name: string;
  email: string;
}

/** 保存载荷（POST/PUT /api/letters）。 */
export interface LetterPayload {
  title: string;
  body_html: string;
  /** TipTap 文档 JSON 字符串，与 body_html 双存。 */
  body_json: string;
  /** UTC ISO；草稿可空。 */
  send_at: string | null;
  timezone: string;
  is_public: boolean;
  recipients: LetterRecipient[];
}

/** 后端返回的完整信件（编辑回填时读取 recipients）。 */
export interface Letter extends LetterPayload {
  id: string;
  status: LetterStatus;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LettersApi {
  list(): Promise<Letter[]>;
  get(id: string): Promise<Letter>;
  create(payload: LetterPayload): Promise<Letter>;
  update(id: string, payload: LetterPayload): Promise<Letter>;
  schedule(id: string): Promise<Letter>;
  cancel(id: string): Promise<Letter>;
  remove(id: string): Promise<void>;
}

async function parseError(res: Response): Promise<Error> {
  let message = `${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // 非 JSON 错误体，忽略
  }
  return new Error(message);
}

/** 真实后端实现：后端④路由就绪后即用。 */
export const httpLettersApi: LettersApi = {
  async list() {
    const res = await fetch("/api/letters");
    if (!res.ok) throw await parseError(res);
    return ((await res.json()) as { letters: Letter[] }).letters;
  },
  async get(id) {
    const res = await fetch(`/api/letters/${id}`);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Letter;
  },
  async create(payload) {
    const res = await fetch("/api/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Letter;
  },
  async update(id, payload) {
    const res = await fetch(`/api/letters/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Letter;
  },
  async schedule(id) {
    const res = await fetch(`/api/letters/${id}/schedule`, { method: "POST" });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Letter;
  },
  async cancel(id) {
    const res = await fetch(`/api/letters/${id}/cancel`, { method: "POST" });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Letter;
  },
  async remove(id) {
    const res = await fetch(`/api/letters/${id}`, { method: "DELETE" });
    if (!res.ok) throw await parseError(res);
  },
};
