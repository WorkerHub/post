// 联调 mock（后端④ /api/letters、/api/contacts 就绪前使用）：
// 形状与冻结契约完全一致，内存态、会话内有效。接通真实接口后置 USE_MOCK=false 即可切换，
// 本文件保留用于单测与离线手测。
import type { ContactsApi, Contact } from "./contacts";
import type {
  Letter,
  LetterPayload,
  LettersApi,
  LetterStatus,
} from "./letters";

const now = () => new Date().toISOString();

function isFutureUtc(utcIso: string | null): boolean {
  if (!utcIso) return false;
  const t = new Date(utcIso).getTime();
  if (Number.isNaN(t)) return false;
  return t > Date.now();
}

interface Store {
  seq: number;
  letters: Map<string, Letter>;
  contacts: Contact[];
}

const store: Store = {
  seq: 0,
  letters: new Map(),
  contacts: [],
};

function nextId(prefix: string): string {
  store.seq += 1;
  return `${prefix}-${store.seq}`;
}

function toLetter(id: string, payload: LetterPayload, overrides: Partial<Letter> = {}): Letter {
  const timestamp = now();
  return {
    id,
    ...payload,
    status: "draft",
    sent_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function getOrThrow(id: string): Letter {
  const letter = store.letters.get(id);
  if (!letter) throw new Error("Not found");
  return letter;
}

export const mockLettersApi: LettersApi = {
  async list() {
    return Array.from(store.letters.values());
  },
  async get(id) {
    return getOrThrow(id);
  },
  async create(payload) {
    const id = nextId("mock-letter");
    const letter = toLetter(id, payload);
    store.letters.set(id, letter);
    return letter;
  },
  async update(id, payload) {
    const existing = getOrThrow(id);
    const letter: Letter = {
      ...existing,
      ...payload,
      updated_at: now(),
    };
    store.letters.set(id, letter);
    return letter;
  },
  async schedule(id) {
    const existing = getOrThrow(id);
    if (existing.recipients.length === 0) {
      throw new Error("请至少添加一位收件人");
    }
    if (!isFutureUtc(existing.send_at)) {
      throw new Error("送达时间须晚于当前时间");
    }
    const letter: Letter = {
      ...existing,
      status: "scheduled",
      updated_at: now(),
    };
    store.letters.set(id, letter);
    return letter;
  },
  async cancel(id) {
    const existing = getOrThrow(id);
    if (existing.status !== "scheduled") {
      throw new Error("仅待寄出的信可取消");
    }
    const letter: Letter = {
      ...existing,
      status: "cancelled" as LetterStatus,
      updated_at: now(),
    };
    store.letters.set(id, letter);
    return letter;
  },
  async remove(id) {
    if (!store.letters.delete(id)) throw new Error("Not found");
  },
};

export const mockContactsApi: ContactsApi = {
  async list() {
    return [...store.contacts];
  },
};

/** 手测用示例联系人（联调 mock 数据，交付汇报已明说）。 */
export function seedMockContacts(contacts: Contact[]): void {
  store.contacts = contacts;
}

/** 单测/手测间重置内存态。 */
export function resetMockStore(): void {
  store.seq = 0;
  store.letters.clear();
  store.contacts = [];
}
