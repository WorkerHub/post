import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeEnv,
  setRawSetting,
  setSendThrottleConfig,
} from "./helpers";
import { tables, type Env, type Letter, type LetterRecipient } from "../src/types";
import {
  buildLetterHtml,
  processDueLetters,
} from "../src/services/scheduler";
import {
  DEFAULT_SEND_THROTTLE_CONFIG,
  SEND_THROTTLE_LIMITS,
  classifySendFailure,
  parseSendThrottleConfig,
  readSendThrottleConfig,
} from "../src/services/send-throttle";
import { setConnectFactory } from "./stubs/sockets";
import { FakeSmtpServer, type FakeSmtpOptions } from "./fake-smtp";

// ─── 独立验证辅助桩与数据准备 ──────────────────────────────────────────────────

const GOOD_SMTP_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  username: "login@example.com",
  password: "s3cret-pass",
  from: "notify@example.com",
  from_name: "时光邮局",
};

const PAST = "2026-01-01T00:00:00.000Z";

function installMultiSmtp(
  handler?: (index: number) => FakeSmtpOptions,
): { servers: FakeSmtpServer[] } {
  const servers: FakeSmtpServer[] = [];
  setConnectFactory((address, options) => {
    const opts = handler ? handler(servers.length) : {};
    const server = new FakeSmtpServer(opts);
    server.connectCalls.push({ address, options });
    servers.push(server);
    return server.socket();
  });
  return { servers };
}

async function setSmtpConfig(
  env: Env,
  config: Record<string, unknown> = GOOD_SMTP_CONFIG,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ${tables(env).system_settings} (key, value, updated_at) VALUES ('smtp_config', ?, '2026-01-01')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(config))
    .run();
}

async function seedLetterWithRecipients(
  env: Env,
  letterId: string,
  recipientCount: number,
  options: {
    sendAt?: string | null;
    status?: string;
    title?: string;
    bodyHtml?: string;
    attempts?: number;
    throttleAttempts?: number;
    nextAttemptAt?: string | null;
  } = {},
): Promise<string> {
  const T = tables(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${T.users} (id, email, password_hash, role, is_active, approval_status, created_at, updated_at)
     VALUES ('u1', 'user@example.com', 'h', 'user', 1, 'approved', '2026-01-01', '2026-01-01')`,
  ).run();

  await env.DB.prepare(
    `INSERT INTO ${T.letters} (id, user_id, title, body_html, body_json, send_at, timezone, status, is_public, attempts, throttle_attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, 'u1', ?, ?, '', ?, 'Asia/Shanghai', ?, 0, ?, ?, ?, '2026-01-01', '2026-01-01')`,
  )
    .bind(
      letterId,
      options.title ?? "测试信件",
      options.bodyHtml ?? "<p>测试正文</p>",
      options.sendAt !== undefined ? options.sendAt : PAST,
      options.status ?? "scheduled",
      options.attempts ?? 0,
      options.throttleAttempts ?? 0,
      options.nextAttemptAt ?? null,
    )
    .run();

  for (let i = 1; i <= recipientCount; i++) {
    await env.DB.prepare(
      `INSERT INTO ${T.letter_recipients} (id, letter_id, name, email, status, created_at)
       VALUES (?, ?, '', ?, 'pending', '2026-01-01')`,
    )
      .bind(`${letterId}-r${i}`, letterId, `${letterId}-r${i}@example.com`)
      .run();
  }

  return letterId;
}

async function getLetter(env: Env, id: string): Promise<Letter | null> {
  return env.DB.prepare(`SELECT * FROM ${tables(env).letters} WHERE id = ?`)
    .bind(id)
    .first<Letter>();
}

async function getRecipients(env: Env, letterId: string): Promise<LetterRecipient[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM ${tables(env).letter_recipients} WHERE letter_id = ? ORDER BY id ASC`,
  )
    .bind(letterId)
    .all<LetterRecipient>();
  return res.results;
}

// ─── 验收测试套件（按补遗 §5 逐项验证） ───────────────────────────────────────

describe("someday 发信节流独立验证（补遗 §5）", () => {
  afterEach(() => {
    setConnectFactory(undefined);
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.1 摊平生效：造 25 个收件人在同一时刻到期
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.1 摊平生效：单轮收件人上限与逐轮平摊", () => {
    it("造 25 个收件人在同一时刻到期，首轮发 10 封，余者保持 scheduled，逐轮补完且不重复", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      // 节流配置：单轮上限 10，测试环境下将间隔设为 0 避免真等
      await setSendThrottleConfig(env, { max_recipients_per_run: 10, interval_ms: 0, jitter_ms: 0 });

      // 造 3 封信共 25 个收件人同刻到期（10 + 10 + 5）
      await seedLetterWithRecipients(env, "let-1", 10, { sendAt: "2026-01-01T09:00:00.000Z" });
      await seedLetterWithRecipients(env, "let-2", 10, { sendAt: "2026-01-01T09:00:00.000Z" });
      await seedLetterWithRecipients(env, "let-3", 5, { sendAt: "2026-01-01T09:00:00.000Z" });

      const multi = installMultiSmtp();

      // 第一轮扫描
      const round1 = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(round1.scanned).toBe(3);
      expect(round1.claimed).toBe(1);
      expect(round1.delivered).toBe(1);
      expect(round1.deferred_by_cap).toBe(15);
      expect(multi.servers).toHaveLength(10);
      expect((await getLetter(env, "let-1"))!.status).toBe("sent");
      expect((await getLetter(env, "let-2"))!.status).toBe("scheduled");
      expect((await getLetter(env, "let-3"))!.status).toBe("scheduled");

      // 第二轮扫描
      const round2 = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(round2.delivered).toBe(1);
      expect(round2.deferred_by_cap).toBe(5);
      expect(multi.servers).toHaveLength(20);
      expect((await getLetter(env, "let-2"))!.status).toBe("sent");
      expect((await getLetter(env, "let-3"))!.status).toBe("scheduled");

      // 第三轮扫描
      const round3 = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(round3.delivered).toBe(1);
      expect(round3.deferred_by_cap).toBe(0);
      expect(multi.servers).toHaveLength(25);
      expect((await getLetter(env, "let-3"))!.status).toBe("sent");

      // 验证无一封重复收到：25 个收件人的 Message-ID 唯一性
      const r1 = await getRecipients(env, "let-1");
      const r2 = await getRecipients(env, "let-2");
      const r3 = await getRecipients(env, "let-3");
      const allRecipients = [...r1, ...r2, ...r3];
      expect(allRecipients).toHaveLength(25);
      expect(allRecipients.every((r) => r.status === "sent")).toBe(true);
      const messageIds = allRecipients.map((r) => r.message_id);
      expect(new Set(messageIds).size).toBe(25);
    });

    it("相邻两封的实际发送时间间隔 ≥ interval_ms（以发送日志/时刻计）", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 4000, jitter_ms: 0, max_recipients_per_run: 10 });
      await seedLetterWithRecipients(env, "let-gap", 3);

      const timestamps: number[] = [];
      setConnectFactory(() => {
        timestamps.push(Date.now());
        const server = new FakeSmtpServer();
        return server.socket();
      });

      vi.useFakeTimers();
      try {
        const runPromise = processDueLetters(env, { timeoutSeconds: 120 });
        // 推进时间让 3 封信的间隔定时器跑完（首封 0s，第 2 封 4s，第 3 封 4s）
        await vi.advanceTimersByTimeAsync(15_000);
        await runPromise;
      } finally {
        vi.useRealTimers();
      }

      expect(timestamps).toHaveLength(3);
      // 首封立刻发送，第 2 封与第 1 封间隔 ≥ 4000ms
      expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(4000);
      // 第 3 封与第 2 封间隔 ≥ 4000ms
      expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(4000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.2 半发续发：一封信带 15 个收件人
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.2 半发续发：一封信多收件人跨轮续发", () => {
    it("一封信带 15 个收件人，首轮发满 10 封后信不卡 sending，下轮只补剩余 5 人，已发者不重复", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { max_recipients_per_run: 10, interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-15", 15);
      const multi = installMultiSmtp();

      // 第一轮扫描
      const round1 = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(round1.deferred_by_cap).toBe(5);
      expect(multi.servers).toHaveLength(10);

      // 关键断言：信件状态绝不卡在 sending，而是回退 scheduled，attempts 不增加
      let letter = await getLetter(env, "let-15");
      expect(letter!.status).toBe("scheduled");
      expect(letter!.attempts).toBe(0);

      const recipients1 = await getRecipients(env, "let-15");
      const sentCount1 = recipients1.filter((r) => r.status === "sent").length;
      const pendingCount1 = recipients1.filter((r) => r.status === "pending").length;
      expect(sentCount1).toBe(10);
      expect(pendingCount1).toBe(5);

      // 第二轮扫描
      const round2 = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(round2.delivered).toBe(1);
      expect(multi.servers).toHaveLength(15);

      letter = await getLetter(env, "let-15");
      expect(letter!.status).toBe("sent");

      const recipients2 = await getRecipients(env, "let-15");
      expect(recipients2.every((r) => r.status === "sent")).toBe(true);

      // 已发的 10 人没有重复投递
      const sentAddresses = multi.servers.flatMap((s) =>
        s.commands.filter((c) => c.toUpperCase().startsWith("RCPT TO")).map((c) => c.slice(8).trim()),
      );
      expect(new Set(sentAddresses).size).toBe(15);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.3 限流退避与全局熔断
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.3 限流退避：452 触发退避阶梯与全局熔断", () => {
    it("可控 SMTP 返回 452：attempts 不增、throttle_attempts+1、next_attempt_at≈+15m、全局熔断", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      const baseNow = Date.now();
      await seedLetterWithRecipients(env, "let-ok", 1, { sendAt: new Date(baseNow - 2000).toISOString() });
      await seedLetterWithRecipients(env, "let-throttle", 1, { sendAt: new Date(baseNow - 1000).toISOString() });
      await seedLetterWithRecipients(env, "let-blocked", 1, { sendAt: new Date(baseNow - 500).toISOString() });

      // 第 1 封成功，第 2 封返回 452 模拟限流，第 3 封正常
      installMultiSmtp((index) => {
        if (index === 1) {
          return { recipientReject: "452 4.7.0 too many messages from your IP" };
        }
        return {};
      });

      const startedAt = Date.now();
      const stats = await processDueLetters(env, { timeoutSeconds: 120 });

      expect(stats.throttled).toBe(1);
      expect(stats.paused_until).toBeTruthy();

      const throttledLetter = await getLetter(env, "let-throttle");
      expect(throttledLetter!.status).toBe("scheduled");
      expect(throttledLetter!.attempts).toBe(0); // 限流退避不消耗 attempts
      expect(throttledLetter!.throttle_attempts).toBe(1);
      expect(throttledLetter!.last_error).toContain("[throttle:452]");

      // 验证 next_attempt_at 约为当前时刻 + 15 分钟
      const nextTime = Date.parse(throttledLetter!.next_attempt_at!);
      const diffMs = nextTime - startedAt;
      expect(diffMs).toBeGreaterThanOrEqual(14 * 60_000);
      expect(diffMs).toBeLessThanOrEqual(16 * 60_000);

      // 验证全局熔断：同轮后序信件停手，未被抢占
      const blockedLetter = await getLetter(env, "let-blocked");
      expect(blockedLetter!.status).toBe("scheduled");
      expect(blockedLetter!.attempts).toBe(0);

      // 验证熔断期内再次触发扫描：零发送，直接跳过并回显 paused_until
      const pauseRun = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(pauseRun.scanned).toBe(0);
      expect(pauseRun.delivered).toBe(0);
      expect(pauseRun.paused_until).toBe(stats.paused_until);
    });

    it("退避期过后自动补发成功，并清空 throttle_attempts 与 next_attempt_at", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-recover", 1, {
        sendAt: new Date().toISOString(),
        throttleAttempts: 1,
        nextAttemptAt: "2000-01-01T00:00:00.000Z", // 退避已过期
      });
      // 解除全局熔断
      await setRawSetting(env, "send_paused_until", "2000-01-01T00:00:00.000Z");

      installMultiSmtp(); // 正常发送
      const stats = await processDueLetters(env, { timeoutSeconds: 120 });

      expect(stats.delivered).toBe(1);
      const letter = await getLetter(env, "let-recover");
      expect(letter!.status).toBe("sent");
      expect(letter!.throttle_attempts).toBe(0);
      expect(letter!.next_attempt_at).toBeNull();
    });

    it("连续命中限流：退避阶梯递增 15m → 30m → 60m → 封顶 60m", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-ladder", 1, { sendAt: new Date().toISOString() });

      installMultiSmtp(() => ({
        recipientReject: "452 4.7.0 rate limit exceeded",
      }));

      const intervals: number[] = [];
      for (let round = 0; round < 4; round++) {
        // 模拟过完熔断与过期时间
        await setRawSetting(env, "send_paused_until", "2000-01-01T00:00:00.000Z");
        await env.DB.prepare(
          `UPDATE ${tables(env).letters} SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = 'let-ladder'`,
        ).run();

        const before = Date.now();
        await processDueLetters(env, { timeoutSeconds: 120 });
        const letter = await getLetter(env, "let-ladder");
        const minutes = Math.round((Date.parse(letter!.next_attempt_at!) - before) / 60_000);
        intervals.push(minutes);
      }

      expect(intervals).toEqual([15, 30, 60, 60]);
    });

    it("退避时刻超过 send_at + 24 小时 → 直接置 failed 且注明限流退避超时", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      // send_at 为 25 小时前（超过 24 小时窗口）
      const expiredSendAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
      await seedLetterWithRecipients(env, "let-overdue", 1, { sendAt: expiredSendAt });

      installMultiSmtp(() => ({
        recipientReject: "452 4.7.0 temporarily rate limited",
      }));

      const stats = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(stats.failed).toBe(1);

      const letter = await getLetter(env, "let-overdue");
      expect(letter!.status).toBe("failed");
      expect(letter!.attempts).toBe(0);
      expect(letter!.throttle_attempts).toBe(1);
      expect(letter!.last_error).toContain("限流退避");
      expect(letter!.last_error).toContain("已超过 send_at + 24 小时");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.4 永久错误不退避
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.4 永久错误不退避：550 走原路径计 attempts 达 3 次置 failed，不触发熔断", () => {
    it("返回 550 的收件人走原路径计 attempts，不触发全局熔断，同轮其他信照常发送", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-perm-fail", 1);
      await seedLetterWithRecipients(env, "let-perm-ok", 1);

      // 第 1 封 550，第 2 封成功
      installMultiSmtp((index) => {
        if (index === 0) {
          return { rejectRecipient: true }; // 550 5.1.1 no such user
        }
        return {};
      });

      const stats = await processDueLetters(env, { timeoutSeconds: 120 });

      expect(stats.paused_until).toBeNull(); // 不触发熔断
      expect(stats.throttled).toBe(0);
      expect(stats.delivered).toBe(1);

      const failedLetter = await getLetter(env, "let-perm-fail");
      expect(failedLetter!.status).toBe("scheduled");
      expect(failedLetter!.attempts).toBe(1); // 正常增加 attempts
      expect(failedLetter!.throttle_attempts).toBe(0);
      expect(failedLetter!.next_attempt_at).toBeNull();
      expect(failedLetter!.last_error).toContain("[permanent:550]");

      const okLetter = await getLetter(env, "let-perm-ok");
      expect(okLetter!.status).toBe("sent");
    });

    it("attempts 达到 3 次整信置 failed", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-3attempts", 1, { attempts: 2 });
      installMultiSmtp(() => ({ rejectRecipient: true }));

      const stats = await processDueLetters(env, { timeoutSeconds: 120 });
      expect(stats.failed).toBe(1);

      const letter = await getLetter(env, "let-3attempts");
      expect(letter!.status).toBe("failed");
      expect(letter!.attempts).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.5 Message-ID 与信件编号防去重
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.5 Message-ID 与信件编号：格式合规、落库与落款包含编号", () => {
    it("同一封信的两个收件人收到的 Message-ID 不同且均已落库，带 X-Someday-Letter-Id 头", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-mid", 2);
      const multi = installMultiSmtp();

      await processDueLetters(env, { timeoutSeconds: 120 });

      const recipients = await getRecipients(env, "let-mid");
      expect(recipients).toHaveLength(2);
      expect(recipients[0]!.message_id).toBeTruthy();
      expect(recipients[1]!.message_id).toBeTruthy();
      expect(recipients[0]!.message_id).not.toBe(recipients[1]!.message_id);

      // 验证格式：<sr.{letter_id}.{recipient_id}.{rand}@{fromDomain}>
      expect(recipients[0]!.message_id).toMatch(/^<sr\.let-mid\.let-mid-r1\.[a-z0-9]+@example\.com>$/);
      expect(recipients[1]!.message_id).toMatch(/^<sr\.let-mid\.let-mid-r2\.[a-z0-9]+@example\.com>$/);

      // 验证真实 SMTP 报文中携带了 Message-ID 与 X-Someday-Letter-Id
      expect(multi.servers[0]!.message).toContain(`Message-ID: ${recipients[0]!.message_id}`);
      expect(multi.servers[0]!.message).toContain("X-Someday-Letter-Id: let-mid");
      expect(multi.servers[1]!.message).toContain(`Message-ID: ${recipients[1]!.message_id}`);
      expect(multi.servers[1]!.message).toContain("X-Someday-Letter-Id: let-mid");
    });

    it("落款含正确信件编号，且不污染正文与标题", () => {
      const letter = {
        id: "letter-xyz-789",
        user_id: "u1",
        title: "未来的一封信",
        body_html: "<p>你好，这是原始正文</p>",
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
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20",
      } as Letter;

      const html = buildLetterHtml(letter);
      expect(html).toContain("<h2>未来的一封信</h2>");
      expect(html).toContain("<p>你好，这是原始正文</p>");
      expect(html).toContain("这封信写于 2026-05-20，由时光邮局送达");
      expect(html).toContain("信件编号：letter-xyz-789");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.6 配置回退与非法参数处理
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.6 配置回退：缺失与非法值自动回退默认并记日志", () => {
    it("缺失 send_throttle_config 时回退默认配置", async () => {
      const env = makeEnv();
      const config = await readSendThrottleConfig(env.DB, "post_");
      expect(config).toEqual(DEFAULT_SEND_THROTTLE_CONFIG);
      expect(config).toEqual({
        interval_ms: 4000,
        jitter_ms: 2000,
        max_recipients_per_run: 10,
      });
    });

    it("写入非法值（负数/越界/非整数）不崩溃、逐项回退默认并有日志", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const parsed = parseSendThrottleConfig(
        JSON.stringify({
          interval_ms: -500,
          jitter_ms: 9999999,
          max_recipients_per_run: "invalid",
        }),
      );

      expect(parsed.config).toEqual(DEFAULT_SEND_THROTTLE_CONFIG);
      expect(parsed.issues).toHaveLength(3);

      const env = makeEnv();
      await setRawSetting(
        env,
        "send_throttle_config",
        JSON.stringify({ interval_ms: -100 }),
      );
      const readConfig = await readSendThrottleConfig(env.DB, "post_");
      expect(readConfig.interval_ms).toBe(DEFAULT_SEND_THROTTLE_CONFIG.interval_ms);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("边界范围与补遗 §3.1.3 合法范围逐项一致", () => {
      expect(SEND_THROTTLE_LIMITS.interval_ms).toEqual({ min: 0, max: 30000 });
      expect(SEND_THROTTLE_LIMITS.jitter_ms).toEqual({ min: 0, max: 10000 });
      expect(SEND_THROTTLE_LIMITS.max_recipients_per_run).toEqual({ min: 1, max: 100 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.7 既有回归验证
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.7 既有回归：定时扫描基础行为未破坏，到期信恰好送达一封", () => {
    it("只处理 scheduled 且已到期的信件，draft/未来信件绝不动", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-due", 1, { sendAt: "2020-01-01T00:00:00.000Z" });
      await seedLetterWithRecipients(env, "let-future", 1, { sendAt: "2999-01-01T00:00:00.000Z" });
      await seedLetterWithRecipients(env, "let-draft", 1, { status: "draft", sendAt: null });

      const multi = installMultiSmtp();
      const stats = await processDueLetters(env, { timeoutSeconds: 120 });

      expect(stats.delivered).toBe(1);
      expect(multi.servers).toHaveLength(1);
      expect((await getLetter(env, "let-due"))!.status).toBe("sent");
      expect((await getLetter(env, "let-future"))!.status).toBe("scheduled");
      expect((await getLetter(env, "let-draft"))!.status).toBe("draft");
    });

    it("单封到期信恰好送达一封，并发扫描因状态抢占不重复发送", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      await seedLetterWithRecipients(env, "let-single", 1);
      const multi = installMultiSmtp();

      // 并发两次扫描调用
      const [res1, res2] = await Promise.all([
        processDueLetters(env, { timeoutSeconds: 120 }),
        processDueLetters(env, { timeoutSeconds: 120 }),
      ]);

      expect(res1.delivered + res2.delivered).toBe(1);
      expect(multi.servers).toHaveLength(1);
      expect((await getLetter(env, "let-single"))!.status).toBe("sent");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §5.8 部署侧与可观察性核验
  // ─────────────────────────────────────────────────────────────────────────
  describe("§5.8 部署侧与可观察性指标核验", () => {
    it("运行指标完整包含补遗 §3.4 要求的 8 项 DeliveryStats", async () => {
      const env = makeEnv();
      await setSmtpConfig(env);
      await setSendThrottleConfig(env, { interval_ms: 0, jitter_ms: 0 });

      const stats = await processDueLetters(env, { timeoutSeconds: 120 });
      const keys = Object.keys(stats).sort();
      expect(keys).toEqual([
        "claimed",
        "deferred_by_cap",
        "delivered",
        "failed",
        "partialFailed",
        "paused_until",
        "scanned",
        "throttled",
      ]);
    });

    it("错误分类带前缀 [throttle:452] 与 [permanent:550]", () => {
      const throttleErr = classifySendFailure({
        code: 452,
        text: "4.7.0 too many recipients",
      });
      expect(throttleErr.kind).toBe("throttle");

      const permErr = classifySendFailure({
        code: 550,
        text: "5.1.1 mailbox unavailable",
      });
      expect(permErr.kind).toBe("permanent");
    });
  });
});
