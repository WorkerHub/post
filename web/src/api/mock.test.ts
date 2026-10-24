import { beforeEach, describe, expect, it } from "vitest";

import { mockLettersApi, mockContactsApi, resetMockStore, seedMockContacts } from "./mock";
import type { LetterPayload } from "./letters";

function payload(overrides: Partial<LetterPayload> = {}): LetterPayload {
  return {
    title: "测试信",
    body_html: "<p>你好</p>",
    body_json: '{"type":"doc","content":[{"type":"paragraph"}]}',
    send_at: "2030-01-01T01:00:00.000Z",
    timezone: "Asia/Shanghai",
    is_public: false,
    recipients: [{ contact_id: null, name: "", email: "a@b.com" }],
    ...overrides,
  };
}

beforeEach(() => {
  resetMockStore();
});

describe("mockLettersApi 状态流转（与后端④同形状）", () => {
  it("create → schedule → cancel 全流程", async () => {
    const draft = await mockLettersApi.create(payload());
    expect(draft.status).toBe("draft");

    const scheduled = await mockLettersApi.schedule(draft.id);
    expect(scheduled.status).toBe("scheduled");

    const cancelled = await mockLettersApi.cancel(draft.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("无收件人时 schedule 报错", async () => {
    const draft = await mockLettersApi.create(payload({ recipients: [] }));
    await expect(mockLettersApi.schedule(draft.id)).rejects.toThrow(/收件人/);
  });

  it("send_at 非法（空/过去）时 schedule 报错", async () => {
    const past = await mockLettersApi.create(
      payload({ send_at: "2000-01-01T00:00:00.000Z" }),
    );
    await expect(mockLettersApi.schedule(past.id)).rejects.toThrow(/晚于当前时间/);

    const empty = await mockLettersApi.create(payload({ send_at: null }));
    await expect(mockLettersApi.schedule(empty.id)).rejects.toThrow(/晚于当前时间/);
  });

  it("非 scheduled 状态取消报错", async () => {
    const draft = await mockLettersApi.create(payload());
    await expect(mockLettersApi.cancel(draft.id)).rejects.toThrow(/仅待寄出/);
  });

  it("update 覆盖内容并保留 id/created_at", async () => {
    const draft = await mockLettersApi.create(payload());
    const updated = await mockLettersApi.update(draft.id, payload({ title: "改后的标题" }));
    expect(updated.id).toBe(draft.id);
    expect(updated.title).toBe("改后的标题");
    expect(updated.created_at).toBe(draft.created_at);
  });

  it("get 不存在的 id 报错", async () => {
    await expect(mockLettersApi.get("nope")).rejects.toThrow();
  });
});

describe("mockContactsApi", () => {
  it("seed 后 list 返回联系人", async () => {
    seedMockContacts([
      { id: "c1", name: "妈妈", email: "a@b.com" },
      { id: "c2", name: "小明", email: "name+tag@example.co.uk" },
    ]);
    const list = await mockContactsApi.list();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("妈妈");
  });
});
