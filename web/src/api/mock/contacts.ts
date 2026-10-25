// 联调 mock：联系人 CRUD + (user_id, email) 唯一校验（与后端④同形状）。
import type { Contact, ContactPayload, ContactsApi } from "../contacts";
import { nextId, now, state } from "./store";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const mockContactsApi: ContactsApi = {
  async list() {
    return [...state.contacts];
  },
  async get(id) {
    const contact = state.contacts.find((c) => c.id === id);
    if (!contact) throw new Error("Not found");
    return contact;
  },
  async create(payload: ContactPayload) {
    const email = payload.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("邮箱格式不正确");
    if (state.contacts.some((c) => c.email.toLowerCase() === email)) {
      throw new Error("该邮箱已存在于联系人中");
    }
    const timestamp = now();
    const contact: Contact = {
      id: nextId("mock-contact"),
      name: payload.name.trim(),
      email,
      notes: payload.notes.trim(),
      tags: payload.tags.map((t) => t.trim()).filter(Boolean),
      created_at: timestamp,
      updated_at: timestamp,
    };
    state.contacts.push(contact);
    return contact;
  },
  async update(id, payload: ContactPayload) {
    const idx = state.contacts.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error("Not found");
    const email = payload.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("邮箱格式不正确");
    if (state.contacts.some((c) => c.id !== id && c.email.toLowerCase() === email)) {
      throw new Error("该邮箱已存在于联系人中");
    }
    const existing = state.contacts[idx];
    const contact: Contact = {
      ...existing,
      name: payload.name.trim(),
      email,
      notes: payload.notes.trim(),
      tags: payload.tags.map((t) => t.trim()).filter(Boolean),
      updated_at: now(),
    };
    state.contacts[idx] = contact;
    return contact;
  },
  async remove(id) {
    const idx = state.contacts.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error("Not found");
    state.contacts.splice(idx, 1);
  },
};
