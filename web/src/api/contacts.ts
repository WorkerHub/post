// 联系人契约（ONE-176，SPEC §7）：
// GET/POST /api/contacts、GET/PUT/DELETE /api/contacts/:id。
// 联系人字段：name、email、notes（备注）、tags（多标签，JSON 数组）；(user_id, email) 唯一。
// 写信页选择器复用同一数据源（只消费 id/name/email，见 ONE-175）。

export interface Contact {
  id: string;
  name: string;
  email: string;
  notes: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** 创建/更新载荷（id/时间戳由后端生成）。 */
export interface ContactPayload {
  name: string;
  email: string;
  notes: string;
  tags: string[];
}

/** 测试/手测播种用的最小形状（notes/tags 缺省补空）。 */
export type ContactSeed = Pick<Contact, "id" | "name" | "email"> &
  Partial<Pick<Contact, "notes" | "tags">>;

export interface ContactsApi {
  list(): Promise<Contact[]>;
  get(id: string): Promise<Contact>;
  create(payload: ContactPayload): Promise<Contact>;
  update(id: string, payload: ContactPayload): Promise<Contact>;
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
export const httpContactsApi: ContactsApi = {
  async list() {
    const res = await fetch("/api/contacts");
    if (!res.ok) throw await parseError(res);
    return ((await res.json()) as { contacts: Contact[] }).contacts;
  },
  async get(id) {
    const res = await fetch(`/api/contacts/${id}`);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Contact;
  },
  async create(payload) {
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Contact;
  },
  async update(id, payload) {
    const res = await fetch(`/api/contacts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as Contact;
  },
  async remove(id) {
    const res = await fetch(`/api/contacts/${id}`, { method: "DELETE" });
    if (!res.ok) throw await parseError(res);
  },
};
