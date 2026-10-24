// 联系人选择器数据源（ONE-175，与后端对齐）：GET /api/contacts。
// 前端写信页只消费 id/name/email 三个字段（notes/tags 在联系人页处理）。

export interface Contact {
  id: string;
  name: string;
  email: string;
}

export interface ContactsApi {
  list(): Promise<Contact[]>;
}

/** 真实后端实现：后端④路由就绪后即用。 */
export const httpContactsApi: ContactsApi = {
  async list() {
    const res = await fetch("/api/contacts");
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // 非 JSON 错误体，忽略
      }
      throw new Error(message);
    }
    return ((await res.json()) as { contacts: Contact[] }).contacts;
  },
};
