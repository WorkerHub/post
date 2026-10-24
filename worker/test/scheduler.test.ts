import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "./helpers";
import type { Env, Letter } from "../src/types";
import { buildLetterHtml, deliverLetter, processDueLetters } from "../src/services/scheduler";

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("../src/services/email", () => ({ sendEmail: sendEmailMock }));

const PAST = "2026-01-01T00:00:00.000Z";

async function seedLetter(
  env: Env,
  recipients: { id: string; email: string; status?: string }[],
  letterOverrides: Partial<Letter> = {},
): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, password_hash, role, is_active, approval_status, created_at, updated_at)
     VALUES ('u1', 'a@b.c', 'h', 'user', 1, 'approved', '2026-01-01', '2026-01-01')`,
  ).run();
  const letterId = letterOverrides.id ?? "letter-1";
  await env.DB.prepare(
    `INSERT INTO letters (id, user_id, title, body_html, body_json, send_at, timezone, status, is_public, attempts, created_at, updated_at)
     VALUES (?, 'u1', ?, ?, '', ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(
      letterId,
      letterOverrides.title ?? "我的信",
      letterOverrides.body_html ?? "<p>正文</p>",
      letterOverrides.send_at !== undefined ? letterOverrides.send_at : PAST,
      letterOverrides.timezone ?? "Asia/Shanghai",
      letterOverrides.status ?? "scheduled",
      letterOverrides.attempts ?? 0,
      letterOverrides.created_at ?? "2024-05-06T10:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )
    .run();

  for (const r of recipients) {
    await env.DB.prepare(
      `INSERT INTO letter_recipients (id, letter_id, name, email, status, created_at)
       VALUES (?, ?, '', ?, ?, '2026-01-01')`,
    )
      .bind(r.id, letterId, r.email, r.status ?? "pending")
      .run();
  }
  return letterId;
}

async function letterById(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM letters WHERE id = ?`).bind(id).first<Letter>();
}

async function recipientsOf(env: Env, letterId: string) {
  const res = await env.DB.prepare(
    `SELECT * FROM letter_recipients WHERE letter_id = ? ORDER BY id ASC`,
  )
    .bind(letterId)
    .all<{ id: string; email: string; status: string; error: string | null }>();
  return res.results;
}

beforeEach(() => {
  sendEmailMock.mockReset();
});

describe("processDueLetters 抢占（SPEC §5）", () => {
  it("只处理 scheduled 且到期的信，draft/未来信不动", async () => {
    const env = makeEnv();
    await seedLetter(env, [{ id: "r1", email: "a@x.com" }], { id: "due" });
    await seedLetter(env, [{ id: "r2", email: "b@x.com" }], {
      id: "future",
      send_at: "2999-01-01T00:00:00.000Z",
    });
    await seedLetter(env, [{ id: "r3", email: "c@x.com" }], {
      id: "draft",
      status: "draft",
      send_at: null,
    });
    sendEmailMock.mockResolvedValue({ success: true });

    const stats = await processDueLetters(env);

    expect(stats.delivered).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][1].to).toBe("a@x.com");
    expect((await letterById(env, "due"))!.status).toBe("sent");
    expect((await letterById(env, "future"))!.status).toBe("scheduled");
    expect((await letterById(env, "draft"))!.status).toBe("draft");
  });

  it("同一封信 cron 重复跑不重复发送（状态抢占生效）", async () => {
    const env = makeEnv();
    await seedLetter(env, [{ id: "r1", email: "a@x.com" }], { id: "l1" });
    sendEmailMock.mockResolvedValue({ success: true });

    // 并发抢占：两次 deliverLetter 只有一次能拿到 changes=1
    await Promise.all([deliverLetter(env, "l1"), deliverLetter(env, "l1")]);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect((await letterById(env, "l1"))!.status).toBe("sent");
    expect((await recipientsOf(env, "l1"))[0].status).toBe("sent");
  });

  it("send_at 为 NULL 的 scheduled 信不会被扫描（防御）", async () => {
    const env = makeEnv();
    await seedLetter(env, [{ id: "r1", email: "a@x.com" }], {
      id: "l1",
      send_at: null,
    });
    sendEmailMock.mockResolvedValue({ success: true });

    const stats = await processDueLetters(env);
    expect(stats.scanned).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("逐收件人投递（互不可见）", () => {
  it("每个收件人独立发一封，正文不含其他收件人地址", async () => {
    const env = makeEnv();
    await seedLetter(env, [
      { id: "r1", email: "alice@example.com" },
      { id: "r2", email: "bob@example.com" },
      { id: "r3", email: "carol@example.com" },
    ], { id: "l1", title: "问候" });
    sendEmailMock.mockResolvedValue({ success: true });

    await processDueLetters(env);

    expect(sendEmailMock).toHaveBeenCalledTimes(3);
    const calls = sendEmailMock.mock.calls.map((c) => c[1] as { to: string; subject: string; html: string });
    const tos = calls.map((c) => c.to).sort();
    expect(tos).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);

    for (const call of calls) {
      expect(call.subject).toBe("问候");
      // 互不可见：每封正文都不能出现任何其他收件人邮箱
      for (const other of tos.filter((t) => t !== call.to)) {
        expect(call.html).not.toContain(other);
      }
    }

    const recipients = await recipientsOf(env, "l1");
    expect(recipients.every((r) => r.status === "sent")).toBe(true);
    expect((await letterById(env, "l1"))!.status).toBe("sent");
    expect((await letterById(env, "l1"))!.sent_at).toBeTruthy();
  });
});

describe("部分失败与重试", () => {
  it("部分失败：失败者记 error，信回 scheduled + attempts+1，下个周期只补发失败收件人", async () => {
    const env = makeEnv();
    await seedLetter(env, [
      { id: "r1", email: "bad@example.com" },
      { id: "r2", email: "good@example.com" },
    ], { id: "l1" });

    // 第一次：r1 失败、r2 成功
    sendEmailMock.mockImplementation(async (_env: Env, o: { to: string }) =>
      o.to === "bad@example.com"
        ? { success: false, error: "SMTP error: expected 250, got 550 — no such user" }
        : { success: true },
    );
    const first = await processDueLetters(env);
    expect(first.partialFailed).toBe(1);

    let letter = await letterById(env, "l1");
    expect(letter!.status).toBe("scheduled");
    expect(letter!.attempts).toBe(1);
    expect(letter!.last_error).toContain("bad@example.com");
    let recipients = await recipientsOf(env, "l1");
    expect(recipients.find((r) => r.id === "r1")!.status).toBe("failed");
    expect(recipients.find((r) => r.id === "r2")!.status).toBe("sent");

    // 第二次：全部成功 → 只补发 r1（r2 不重发）
    sendEmailMock.mockResolvedValue({ success: true });
    await processDueLetters(env);

    // r2 成功那封只在第一轮发过；第二轮只发 r1
    const tos = sendEmailMock.mock.calls.map((c) => c[1].to);
    expect(tos.filter((t) => t === "good@example.com")).toHaveLength(1);
    expect(tos.filter((t) => t === "bad@example.com")).toHaveLength(2);

    letter = await letterById(env, "l1");
    expect(letter!.status).toBe("sent");
    expect(letter!.last_error).toBeNull();
    recipients = await recipientsOf(env, "l1");
    expect(recipients.every((r) => r.status === "sent")).toBe(true);
  });

  it("attempts 达 3 次仍失败 → 置 failed 并汇总 last_error", async () => {
    const env = makeEnv();
    await seedLetter(env, [{ id: "r1", email: "bad@example.com" }], { id: "l1" });
    sendEmailMock.mockResolvedValue({ success: false, error: "SMTP error: auth failed" });

    await processDueLetters(env); // attempts 1
    let letter = await letterById(env, "l1");
    expect(letter!.status).toBe("scheduled");
    expect(letter!.attempts).toBe(1);

    await processDueLetters(env); // attempts 2
    letter = await letterById(env, "l1");
    expect(letter!.status).toBe("scheduled");
    expect(letter!.attempts).toBe(2);

    const stats = await processDueLetters(env); // attempts 3 → failed
    expect(stats.gaveUp).toBe(1);
    letter = await letterById(env, "l1");
    expect(letter!.status).toBe("failed");
    expect(letter!.attempts).toBe(3);
    expect(letter!.last_error).toContain("auth failed");
    expect(sendEmailMock).toHaveBeenCalledTimes(3);

    // 已 failed 的信不再被扫描
    await processDueLetters(env);
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
  });
});

describe("buildLetterHtml 模板", () => {
  it("标题转义 + 正文消毒 + 落款", () => {
    const letter = {
      id: "l1",
      user_id: "u1",
      title: '<script>alert(1)</script>标题',
      body_html: '<p>正文</p><script>evil()</script>',
      body_json: "",
      send_at: PAST,
      timezone: "Asia/Shanghai",
      status: "scheduled",
      is_public: 0,
      attempts: 0,
      last_error: null,
      sent_at: null,
      created_at: "2024-05-06T10:00:00.000Z",
      updated_at: "2026-01-01",
    } as Letter;

    const html = buildLetterHtml(letter);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("evil()");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); // 标题被转义为纯文本
    expect(html).toContain("<p>正文</p>");
    expect(html).toContain("这封信写于 2024-05-06，由时光邮局送达");
  });

  it("时区无效时回退 UTC 日期，标题为空时不输出 h2", () => {
    const letter = {
      id: "l2",
      user_id: "u1",
      title: "",
      body_html: "<p>x</p>",
      body_json: "",
      send_at: PAST,
      timezone: "Not/AZone",
      status: "scheduled",
      is_public: 0,
      attempts: 0,
      last_error: null,
      sent_at: null,
      created_at: "2024-05-06T23:00:00.000Z",
      updated_at: "2026-01-01",
    } as Letter;

    const html = buildLetterHtml(letter);
    expect(html).not.toContain("<h2>");
    expect(html).toContain("这封信写于 2024-05-06，由时光邮局送达");
  });
});
