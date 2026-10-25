// 联调 mock：letters 状态流转与后端④同形状（见 mock.test.ts）。
import type { Letter, LetterPatch, LetterPayload, LettersApi, LetterStatus } from "../letters";
import { nextId, now, state } from "./store";

function isFutureUtc(utcIso: string | null): boolean {
  if (!utcIso) return false;
  const t = new Date(utcIso).getTime();
  if (Number.isNaN(t)) return false;
  return t > Date.now();
}

function toLetter(id: string, payload: LetterPayload, overrides: Partial<Letter> = {}): Letter {
  const timestamp = now();
  return {
    id,
    ...payload,
    status: "draft",
    attempts: 0,
    last_error: null,
    sent_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function getOrThrow(id: string): Letter {
  const letter = state.letters.get(id);
  if (!letter) throw new Error("Not found");
  return letter;
}

export const mockLettersApi: LettersApi = {
  async list() {
    return Array.from(state.letters.values());
  },
  async get(id) {
    return getOrThrow(id);
  },
  async create(payload) {
    const id = nextId("mock-letter");
    const letter = toLetter(id, payload);
    state.letters.set(id, letter);
    return letter;
  },
  async update(id, payload) {
    const existing = getOrThrow(id);
    // 已取消的信重新编辑保存 → 回到草稿（可再次寄出）
    const letter: Letter = {
      ...existing,
      ...payload,
      status: existing.status === "cancelled" ? "draft" : existing.status,
      updated_at: now(),
    };
    state.letters.set(id, letter);
    return letter;
  },
  async patch(id, patch: LetterPatch) {
    const existing = getOrThrow(id);
    const letter: Letter = { ...existing, ...patch, updated_at: now() };
    state.letters.set(id, letter);
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
    state.letters.set(id, letter);
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
    state.letters.set(id, letter);
    return letter;
  },
  async resend(id) {
    const existing = getOrThrow(id);
    if (existing.status !== "failed") {
      throw new Error("仅失败的信可重发");
    }
    const letter: Letter = {
      ...existing,
      status: "scheduled",
      attempts: 0,
      last_error: null,
      updated_at: now(),
    };
    state.letters.set(id, letter);
    return letter;
  },
  async remove(id) {
    if (!state.letters.delete(id)) throw new Error("Not found");
  },
};

/** 手测/单测播种信件（直接写入内存态，可指定任意状态与 last_error/attempts）。 */
export function seedMockLetters(letters: Letter[]): void {
  for (const l of letters) state.letters.set(l.id, l);
}
