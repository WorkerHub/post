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

/** 状态中文标签（工作台/写信页共用）。 */
export const LETTER_STATUS_LABEL: Record<LetterStatus, string> = {
  draft: "草稿",
  scheduled: "待寄出",
  sending: "发送中",
  sent: "已寄出",
  failed: "失败",
  cancelled: "已取消",
};

/** 收件人快照：contact_id 指向联系人（可空），name/email 为保存时快照。 */
export interface LetterRecipient {
  contact_id: string | null;
  name: string;
  email: string;
  /** 投递状态（后端 serializeLetter 透出；保存载荷无需提供） */
  status?: "pending" | "sent" | "failed";
  /** 投递失败原因（Resend webhook 回写 / SMTP 失败）；保存载荷无需提供 */
  error?: string | null;
  /** 实际寄出时刻（UTC ISO）；保存载荷无需提供 */
  sent_at?: string | null;
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

/** PATCH /api/letters/:id 的部分字段更新（is_public 开关等）。 */
export interface LetterPatch {
  is_public?: boolean;
}

/** 后端返回的完整信件（编辑回填时读取 recipients；失败视图读取 last_error/attempts）。 */
export interface Letter extends LetterPayload {
  id: string;
  status: LetterStatus;
  /** 已尝试投递次数；重发时归零由用户确认。 */
  attempts: number;
  /** 失败原因汇总（status=failed 时可见）。 */
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LettersApi {
  list(): Promise<Letter[]>;
  get(id: string): Promise<Letter>;
  create(payload: LetterPayload): Promise<Letter>;
  update(id: string, payload: LetterPayload): Promise<Letter>;
  patch(id: string, patch: LetterPatch): Promise<Letter>;
  schedule(id: string): Promise<Letter>;
  cancel(id: string): Promise<Letter>;
  /** 失败重发：回 scheduled，attempts 归零。 */
  resend(id: string): Promise<Letter>;
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
  async patch(id, patch) {
    const res = await fetch(`/api/letters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
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
  async resend(id) {
    const res = await fetch(`/api/letters/${id}/resend`, { method: "POST" });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Letter;
  },
  async remove(id) {
    const res = await fetch(`/api/letters/${id}`, { method: "DELETE" });
    if (!res.ok) throw await parseError(res);
  },
};
