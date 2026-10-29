import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, setRawSetting, setSendThrottleConfig } from "./helpers";
import { tables, type Env, type Letter, type LetterRecipient } from "../src/types";
import { buildLetterHtml, deliverLetter, processDueLetters } from "../src/services/scheduler";

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("../src/services/email", () => ({ sendEmail: sendEmailMock }));

const PAST = "2026-01-01T00:00:00.000Z";

async function seedLetter(
  env: Env,
  recipients: { id: string; email: string; status?: string }[],
  letterOverrides: Partial<Letter> = {},
): Promise<string> {
  const T = tables(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${T.users} (id, email, password_hash, role, is_active, approval_status, created_at, updated_at)
     VALUES ('u1', 'a@b.c', 'h', 'user', 1, 'approved', '2026-01-01', '2026-01-01')`,
  ).run();
  const letterId = letterOverrides.id ?? "letter-1";
  await env.DB.prepare(
    `INSERT INTO ${T.letters} (id, user_id, title, body_html, body_json, send_at, timezone, status, is_public, attempts, created_at, updated_at)
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
      `INSERT INTO ${T.letter_recipients} (id, letter_id, name, email, status, created_at)
       VALUES (?, ?, '', ?, ?, '2026-01-01')`,
    )
      .bind(r.id, letterId, r.email, r.status ?? "pending")
      .run();
  }
  return letterId;
}

async function letterById(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM ${tables(env).letters} WHERE id = ?`)
    .bind(id)
    .first<Letter>();
}

async function recipientsOf(env: Env, letterId: string) {
  const res = await env.DB.prepare(
    `SELECT * FROM ${tables(env).letter_recipients} WHERE letter_id = ? ORDER BY id ASC`,
  )
    .bind(letterId)
    .all<LetterRecipient>();
  return res.results;
}

/** 把「现在」写成 24 小时窗口内的 send_at（限流退避用例必须如此，否则退避直接超窗置 failed）。 */
function recentSendAt(): string {
  return new Date().toISOString();
}

/** 解除熔断：把 send_paused_until 写成过去时刻（等价于熔断期过完）。 */
async function clearPause(env: Env): Promise<void> {
  await setRawSetting(env, "send_paused_until", "2000-01-01T00:00:00.000Z");
}

/** 把某封信的退避时刻挪到过去（等价于 next_attempt_at 已过期）。 */
async function makeLetterDue(env: Env, letterId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE ${tables(env).letters} SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
  )
    .bind(letterId)
    .run();
}

/** 452 限流类失败（经发送层带回回复码与原文）。 */
const THROTTLE_RESULT = {
  success: false,
  error: "SMTP error: expected 250, got 452 — 4.7.0 too many messages",
  code: 452,
  response: "4.7.0 too many messages",
};

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
    await setSendThrottleConfig(env);
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
    await setSendThrottleConfig(env);
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
    expect(stats.failed).toBe(1);
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

// ─── 发信节流补遗 §3.1：单轮上限 + 间隔 ─────────────────────────────────────

async function seedLettersWithCounts(
  env: Env,
  groups: { id: string; count: number; send_at?: string }[],
): Promise<void> {
  for (const group of groups) {
    await seedLetter(
      env,
      Array.from({ length: group.count }, (_, i) => ({
        id: `${group.id}-r${i + 1}`,
        email: `${group.id}-r${i + 1}@example.com`,
      })),
      { id: group.id, send_at: group.send_at ?? PAST },
    );
  }
}

describe("节流：单轮收件人上限（补遗 §3.1.2）", () => {
  it("25 个收件人同刻到期 → 首轮恰 10 封，余者仍 scheduled，逐轮补完且不重复", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env, { max_recipients_per_run: 10 });
    await seedLettersWithCounts(env, [
      { id: "l1", count: 10 },
      { id: "l2", count: 10 },
      { id: "l3", count: 5 },
    ]);
    sendEmailMock.mockResolvedValue({ success: true, messageId: "<r@example.com>" });

    const first = await processDueLetters(env, { timeoutSeconds: 120 });
    expect(first.scanned).toBe(3);
    expect(first.claimed).toBe(1);
    expect(first.delivered).toBe(1);
    expect(first.deferred_by_cap).toBe(15);
    expect(sendEmailMock).toHaveBeenCalledTimes(10);
    expect((await letterById(env, "l1"))!.status).toBe("sent");
    expect((await letterById(env, "l2"))!.status).toBe("scheduled");
    expect((await letterById(env, "l3"))!.status).toBe("scheduled");

    const second = await processDueLetters(env, { timeoutSeconds: 120 });
    expect(second.delivered).toBe(1);
    expect(second.deferred_by_cap).toBe(5);
    expect(sendEmailMock).toHaveBeenCalledTimes(20);

    const third = await processDueLetters(env, { timeoutSeconds: 120 });
    expect(third.delivered).toBe(1);
    expect(third.deferred_by_cap).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(25);

    // 无一封重复
    const sent = sendEmailMock.mock.calls.map((c) => c[1].to as string);
    expect(new Set(sent).size).toBe(25);
    expect((await letterById(env, "l3"))!.status).toBe("sent");
  });

  it("相邻两封的实际发送间隔 ≥ interval_ms（以发送时刻计）", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env, { interval_ms: 4000, jitter_ms: 0 });
    await seedLetter(
      env,
      [
        { id: "r1", email: "a@example.com" },
        { id: "r2", email: "b@example.com" },
        { id: "r3", email: "c@example.com" },
      ],
      { id: "l1" },
    );

    const stamps: number[] = [];
    sendEmailMock.mockImplementation(async () => {
      stamps.push(Date.now());
      return { success: true, messageId: "<r@example.com>" };
    });

    vi.useFakeTimers();
    try {
      const run = processDueLetters(env, { timeoutSeconds: 120 });
      await vi.advanceTimersByTimeAsync(30_000);
      await run;
    } finally {
      vi.useRealTimers();
    }

    expect(stamps).toHaveLength(3);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(4000);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(4000);
  });

  it("运行预算不足时不再抢占：首封仍发，其余按上限顺延", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    await seedLettersWithCounts(env, [
      { id: "l1", count: 1 },
      { id: "l2", count: 1 },
      { id: "l3", count: 1 },
    ]);
    sendEmailMock.mockResolvedValue({ success: true, messageId: "<r@example.com>" });

    const stats = await processDueLetters(env, { timeoutSeconds: 1 });

    expect(stats.claimed).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(stats.deferred_by_cap).toBe(2);
    expect((await letterById(env, "l2"))!.status).toBe("scheduled");
    expect((await letterById(env, "l3"))!.status).toBe("scheduled");
  });
});

describe("节流：半发续发（补遗 §3.1.2）", () => {
  it("一封 15 收件人：首轮发满上限后信不卡 sending，下轮只补剩余 5 人", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env, { max_recipients_per_run: 10 });
    await seedLettersWithCounts(env, [{ id: "l1", count: 15 }]);
    sendEmailMock.mockResolvedValue({ success: true, messageId: "<r@example.com>" });

    const first = await processDueLetters(env, { timeoutSeconds: 120 });
    expect(sendEmailMock).toHaveBeenCalledTimes(10);
    expect(first.deferred_by_cap).toBe(5);
    let letter = await letterById(env, "l1");
    expect(letter!.status).toBe("scheduled");
    expect(letter!.attempts).toBe(0); // 顺延不算失败

    const second = await processDueLetters(env, { timeoutSeconds: 120 });
    expect(sendEmailMock).toHaveBeenCalledTimes(15);
    letter = await letterById(env, "l1");
    expect(letter!.status).toBe("sent");

    const sent = sendEmailMock.mock.calls.map((c) => c[1].to as string);
    expect(new Set(sent).size).toBe(15);
    const recipients = await recipientsOf(env, "l1");
    expect(recipients.every((r) => r.status === "sent")).toBe(true);
  });
});

// ─── 发信节流补遗 §3.2：限流退避 + 全局熔断 ────────────────────────────────

describe("限流退避与熔断（补遗 §3.2）", () => {
  it("452 → attempts 不变、throttle_attempts+1、next_attempt_at≈+15 分钟、本轮停手", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    const base = Date.now();
    await seedLetter(env, [{ id: "r1", email: "a@example.com" }], {
      id: "l1",
      send_at: new Date(base - 3000).toISOString(),
    });
    await seedLetter(env, [{ id: "r2", email: "b@example.com" }], {
      id: "l2",
      send_at: new Date(base - 2000).toISOString(),
    });
    await seedLetter(env, [{ id: "r3", email: "c@example.com" }], {
      id: "l3",
      send_at: new Date(base - 1000).toISOString(),
    });
    sendEmailMock.mockImplementation(async (_env: Env, o: { to: string }) =>
      o.to === "b@example.com" ? THROTTLE_RESULT : { success: true, messageId: "<r@example.com>" },
    );

    const startedAt = Date.now();
    const first = await processDueLetters(env, { timeoutSeconds: 120 });

    expect(first.throttled).toBe(1);
    expect(first.paused_until).toBeTruthy();
    expect(sendEmailMock).toHaveBeenCalledTimes(2); // l1 一发 + l2 命中限流后停手
    const l2 = await letterById(env, "l2");
    expect(l2!.status).toBe("scheduled");
    expect(l2!.attempts).toBe(0); // 退避不烧 attempts
    expect(l2!.throttle_attempts).toBe(1);
    const backoff = Date.parse(l2!.next_attempt_at!) - startedAt;
    expect(backoff).toBeGreaterThanOrEqual(14 * 60_000);
    expect(backoff).toBeLessThanOrEqual(16 * 60_000);
    expect(l2!.last_error).toContain("[throttle:452]");
    // 熔断后同轮不再抢占后面的信
    expect((await letterById(env, "l3"))!.status).toBe("scheduled");

    const throttledRecipient = (await recipientsOf(env, "l2"))[0]!;
    expect(throttledRecipient.status).toBe("failed");
    expect(throttledRecipient.error).toContain("[throttle:452]");
    expect(throttledRecipient.message_id).toBeNull();

    // 熔断期内再触发：零发送，只带 paused_until 回来
    sendEmailMock.mockClear();
    const second = await processDueLetters(env, { timeoutSeconds: 120 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(second.scanned).toBe(0);
    expect(second.paused_until).toBe(first.paused_until);
  });

  it("单封信部分收件人命中限流：已成功者不重发，未发/命中者退避后补发", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    await seedLetter(
      env,
      [
        { id: "r1", email: "a@example.com" },
        { id: "r2", email: "b@example.com" },
        { id: "r3", email: "c@example.com" },
      ],
      { id: "l1", send_at: recentSendAt() },
    );
    sendEmailMock.mockImplementation(async (_env: Env, o: { to: string }) =>
      o.to === "b@example.com" ? THROTTLE_RESULT : { success: true, messageId: "<r@example.com>" },
    );

    await processDueLetters(env, { timeoutSeconds: 120 });
    // 命中限流即停：a 已发成功、b 记限流、c 还没发
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    let rows = await recipientsOf(env, "l1");
    expect(rows.find((r) => r.id === "r1")!.status).toBe("sent");
    expect(rows.find((r) => r.id === "r2")!.status).toBe("failed");
    expect(rows.find((r) => r.id === "r3")!.status).toBe("pending");
    expect((await letterById(env, "l1"))!.status).toBe("scheduled");

    // 退避过后：只补 b、c，a 不重发
    await clearPause(env);
    await makeLetterDue(env, "l1");
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValue({ success: true, messageId: "<r@example.com>" });
    const stats = await processDueLetters(env, { timeoutSeconds: 120 });

    expect(stats.delivered).toBe(1);
    const resent = sendEmailMock.mock.calls.map((c) => c[1].to as string).sort();
    expect(resent).toEqual(["b@example.com", "c@example.com"]);
    rows = await recipientsOf(env, "l1");
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect((await letterById(env, "l1"))!.status).toBe("sent");
  });

  it("退避期过后自动补发成功，并清空 throttle_attempts / next_attempt_at", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    await seedLetter(env, [{ id: "r1", email: "a@example.com" }], { id: "l1", send_at: recentSendAt() });
    sendEmailMock.mockResolvedValue(THROTTLE_RESULT);

    await processDueLetters(env, { timeoutSeconds: 120 });
    expect((await letterById(env, "l1"))!.throttle_attempts).toBe(1);

    await clearPause(env);
    await makeLetterDue(env, "l1");
    sendEmailMock.mockResolvedValue({ success: true, messageId: "<r@example.com>" });

    const stats = await processDueLetters(env, { timeoutSeconds: 120 });
    expect(stats.delivered).toBe(1);
    const letter = await letterById(env, "l1");
    expect(letter!.status).toBe("sent");
    expect(letter!.throttle_attempts).toBe(0);
    expect(letter!.next_attempt_at).toBeNull();
  });

  it("连续命中：退避 15 → 30 → 60 分钟，之后封顶 60 分钟", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    await seedLetter(env, [{ id: "r1", email: "a@example.com" }], { id: "l1", send_at: recentSendAt() });
    sendEmailMock.mockResolvedValue(THROTTLE_RESULT);

    const minutes: number[] = [];
    for (let round = 0; round < 4; round++) {
      await clearPause(env);
      await makeLetterDue(env, "l1");
      const startedAt = Date.now();
      await processDueLetters(env, { timeoutSeconds: 120 });
      const letter = await letterById(env, "l1");
      minutes.push(Math.round((Date.parse(letter!.next_attempt_at!) - startedAt) / 60_000));
    }

    expect(minutes).toEqual([15, 30, 60, 60]);
  });

  it("退避时刻超过 send_at + 24 小时 → 直接置 failed 并注明限流超时", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    const sendAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await seedLetter(env, [{ id: "r1", email: "a@example.com" }], { id: "l1", send_at: sendAt });
    sendEmailMock.mockResolvedValue(THROTTLE_RESULT);

    const stats = await processDueLetters(env, { timeoutSeconds: 120 });

    const letter = await letterById(env, "l1");
    expect(letter!.status).toBe("failed");
    expect(letter!.attempts).toBe(0);
    expect(letter!.throttle_attempts).toBe(1);
    expect(letter!.last_error).toContain("限流退避");
    expect(stats.failed).toBe(1);
  });
});

describe("永久错误不退避（补遗 §3.2.1）", () => {
  it("550 → 计 attempts、不触发熔断、同轮其他信照发", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    await seedLetter(env, [{ id: "r1", email: "gone@example.com" }], { id: "l1" });
    await seedLetter(env, [{ id: "r2", email: "ok@example.com" }], { id: "l2" });
    sendEmailMock.mockImplementation(async (_env: Env, o: { to: string }) =>
      o.to === "gone@example.com"
        ? {
            success: false,
            error: "SMTP error: expected 250, got 550 — 5.1.1 no such user",
            code: 550,
            response: "5.1.1 no such user",
          }
        : { success: true, messageId: "<r@example.com>" },
    );

    const stats = await processDueLetters(env, { timeoutSeconds: 120 });

    expect(stats.paused_until).toBeNull();
    expect(stats.throttled).toBe(0);
    expect(stats.delivered).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const failedLetter = await letterById(env, "l1");
    expect(failedLetter!.status).toBe("scheduled");
    expect(failedLetter!.attempts).toBe(1);
    expect(failedLetter!.throttle_attempts).toBe(0);
    expect(failedLetter!.next_attempt_at).toBeNull();
    expect(failedLetter!.last_error).toContain("[permanent:550]");
    expect((await letterById(env, "l2"))!.status).toBe("sent");
  });
});

// ─── 发信节流补遗 §3.3：Message-ID 与信件编号 ──────────────────────────────

describe("Message-ID 与落款（补遗 §3.3）", () => {
  it("同一封信两个收件人：Message-ID 不同且都已落库", async () => {
    const env = makeEnv();
    await setSendThrottleConfig(env);
    await seedLetter(
      env,
      [
        { id: "r1", email: "a@example.com" },
        { id: "r2", email: "b@example.com" },
      ],
      { id: "l1" },
    );
    sendEmailMock.mockImplementation(
      async (_env: Env, o: { letterId?: string; recipientId?: string }) => ({
        success: true,
        messageId: `<sr.${o.letterId}.${o.recipientId}.${Math.random().toString(36).slice(2)}@example.com>`,
      }),
    );

    await processDueLetters(env, { timeoutSeconds: 120 });

    // 信件/收件人 id 传给了发送层（Message-ID 由 email.ts 据此生成）
    const call = sendEmailMock.mock.calls[0]![1] as { letterId?: string; recipientId?: string };
    expect(call.letterId).toBe("l1");
    expect(call.recipientId).toBe("r1");

    const recipients = await recipientsOf(env, "l1");
    const ids = recipients.map((r) => r.message_id).filter((v): v is string => !!v);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("落款追加信件编号（不改用户正文与标题）", () => {
    const letter = {
      id: "l-no-1",
      user_id: "u1",
      title: "标题",
      body_html: "<p>正文</p>",
      body_json: "",
      send_at: PAST,
      timezone: "Asia/Shanghai",
      status: "scheduled",
      is_public: 0,
      attempts: 0,
      last_error: null,
      sent_at: null,
      next_attempt_at: null,
      throttle_attempts: 0,
      created_at: "2024-05-06T10:00:00.000Z",
      updated_at: "2026-01-01",
    } as Letter;

    const html = buildLetterHtml(letter);
    expect(html).toContain("这封信写于 2024-05-06，由时光邮局送达");
    expect(html).toContain("信件编号：l-no-1");
    expect(html).toContain("<p>正文</p>");
    expect(html).toContain("<h2>标题</h2>");
  });
});
