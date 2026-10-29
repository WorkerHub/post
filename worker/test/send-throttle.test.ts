import { describe, expect, it, vi } from "vitest";
import { makeEnv, setRawSetting } from "./helpers";
import {
  DEFAULT_SEND_THROTTLE_CONFIG,
  SEND_THROTTLE_LIMITS,
  classifySendFailure,
  extractSmtpCode,
  formatDeliveryError,
  parseSendThrottleConfig,
  readSendThrottleConfig,
  sendGapMs,
  sleepMs,
  throttleBackoffMs,
  validateSendThrottleField,
} from "../src/services/send-throttle";

// 发信节流补遗 §3.1.4 / §3.2.1：配置回退、限流分类、退避序列。

describe("节流配置解析与回退（补遗 §3.1.4）", () => {
  it("缺失 → 全默认值，且不产生 issues", () => {
    const parsed = parseSendThrottleConfig(null);
    expect(parsed.config).toEqual(DEFAULT_SEND_THROTTLE_CONFIG);
    expect(parsed.issues).toEqual([]);
    expect(parsed.invalidJson).toBe(false);
  });

  it("默认值与补遗 §3.1.3 的表格逐项一致", () => {
    expect(DEFAULT_SEND_THROTTLE_CONFIG).toEqual({
      interval_ms: 4000,
      jitter_ms: 2000,
      max_recipients_per_run: 10,
    });
    expect(SEND_THROTTLE_LIMITS).toEqual({
      interval_ms: { min: 0, max: 30_000 },
      jitter_ms: { min: 0, max: 10_000 },
      max_recipients_per_run: { min: 1, max: 100 },
    });
  });

  it("字段缺失 → 该项回默认（不算问题）", () => {
    const parsed = parseSendThrottleConfig(JSON.stringify({ interval_ms: 1000 }));
    expect(parsed.config.interval_ms).toBe(1000);
    expect(parsed.config.jitter_ms).toBe(DEFAULT_SEND_THROTTLE_CONFIG.jitter_ms);
    expect(parsed.config.max_recipients_per_run).toBe(
      DEFAULT_SEND_THROTTLE_CONFIG.max_recipients_per_run,
    );
    expect(parsed.issues).toEqual([]);
  });

  it("非法值（负数 / 越界 / 小数 / 字符串）逐项回默认并记 issue", () => {
    const parsed = parseSendThrottleConfig(
      JSON.stringify({
        interval_ms: -1,
        jitter_ms: "2000",
        max_recipients_per_run: 1.5,
      }),
    );
    expect(parsed.config).toEqual(DEFAULT_SEND_THROTTLE_CONFIG);
    expect(parsed.issues.map((i) => i.key)).toEqual([
      "interval_ms",
      "jitter_ms",
      "max_recipients_per_run",
    ]);
  });

  it("整段不是 JSON 对象 → invalidJson + 全默认", () => {
    for (const raw of ["not json", "[]", "42", "null"]) {
      const parsed = parseSendThrottleConfig(raw);
      expect(parsed.invalidJson).toBe(true);
      expect(parsed.config).toEqual(DEFAULT_SEND_THROTTLE_CONFIG);
    }
  });

  it("readSendThrottleConfig：库里值合法则生效，写坏则回默认并 warn", async () => {
    const env = makeEnv();
    await setRawSetting(
      env,
      "send_throttle_config",
      JSON.stringify({ interval_ms: 1500, jitter_ms: 500, max_recipients_per_run: 3 }),
    );
    expect(await readSendThrottleConfig(env.DB, "post_")).toEqual({
      interval_ms: 1500,
      jitter_ms: 500,
      max_recipients_per_run: 3,
    });

    await setRawSetting(env, "send_throttle_config", JSON.stringify({ interval_ms: -5 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await readSendThrottleConfig(env.DB, "post_")).toEqual(
        DEFAULT_SEND_THROTTLE_CONFIG,
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("validateSendThrottleField：接受范围内整数、拒绝其余", () => {
    expect(validateSendThrottleField("interval_ms", 0)).toBe(0);
    expect(validateSendThrottleField("interval_ms", 30_000)).toBe(30_000);
    expect(validateSendThrottleField("interval_ms", 30_001)).toBeNull();
    expect(validateSendThrottleField("interval_ms", 1.2)).toBeNull();
    expect(validateSendThrottleField("interval_ms", "1000")).toBeNull();
    expect(validateSendThrottleField("max_recipients_per_run", 0)).toBeNull();
    expect(validateSendThrottleField("max_recipients_per_run", 100)).toBe(100);
    expect(validateSendThrottleField("jitter_ms", 10_001)).toBeNull();
  });
});

describe("限流分类（补遗 §3.2.1）", () => {
  it("限流类回复码 421/450/451/452 → throttle", () => {
    for (const code of [421, 450, 451, 452]) {
      const result = classifySendFailure({ code, text: `SMTP error: got ${code}` });
      expect(result.kind).toBe("throttle");
      expect(result.code).toBe(code);
    }
  });

  it("永久类回复码 550/551/553 → permanent", () => {
    for (const code of [550, 551, 553]) {
      expect(classifySendFailure({ code, text: `SMTP error: got ${code}` }).kind).toBe(
        "permanent",
      );
    }
  });

  it("没有回复码时按关键词判定限流（含中文），大小写不敏感", () => {
    const cases = [
      "Rate limited, try later",
      "TOO MANY connections",
      "Too Frequent",
      "service TEMPORARILY unavailable",
      "发送过于频繁",
      "触发限流",
      "已超过上限",
    ];
    for (const text of cases) {
      const result = classifySendFailure({ text });
      expect(result.kind, text).toBe("throttle");
      expect(result.code).toBeNull();
    }
  });

  it("配置类/地址类错误维持原路径（other），不退避", () => {
    for (const text of [
      "SMTP not configured",
      "Invalid recipient email address",
      "SMTP error: auth failed",
      "SMTP: connection closed unexpectedly",
    ]) {
      expect(classifySendFailure({ text }).kind, text).toBe("other");
    }
  });

  it("从错误原文回解回复码：取 got 后的码，不把 expected 250 当结果", () => {
    expect(extractSmtpCode("SMTP: expected 250, got 452 — too many")).toBe(452);
    expect(extractSmtpCode("SMTP: expected 250, got 550 — no such user")).toBe(550);
    expect(extractSmtpCode("452 4.7.0 too many recipients")).toBe(452);
    expect(extractSmtpCode("SMTP not configured")).toBeNull();
    // expected 250 + 无 got：不能被当成 250 命中分类表
    expect(classifySendFailure({ text: "SMTP: expected 250, got something odd" }).kind).toBe(
      "other",
    );
  });

  it("回归口径：旧测试里的 550 / 4xx 错误串仍被正确分类", () => {
    expect(
      classifySendFailure({ text: "SMTP error: expected 250, got 550 — no such user" }).kind,
    ).toBe("permanent");
    expect(
      classifySendFailure({ text: "SMTP error: expected 250, got 452 — try later" }).kind,
    ).toBe("throttle");
  });

  it("error 前缀：带码与不带码两种形态", () => {
    expect(
      formatDeliveryError(classifySendFailure({ code: 452, text: "too many" })),
    ).toBe("[throttle:452] too many");
    expect(
      formatDeliveryError(classifySendFailure({ text: "SMTP not configured" })),
    ).toBe("[other] SMTP not configured");
  });
});

describe("退避与等待（补遗 §3.2.2 / §3.1.1）", () => {
  it("退避序列 15 → 30 → 60 分钟，之后封顶 60 分钟", () => {
    expect([1, 2, 3, 4, 5].map((n) => throttleBackoffMs(n) / 60_000)).toEqual([
      15, 30, 60, 60, 60,
    ]);
    // 异常输入兜底成第一档
    expect(throttleBackoffMs(0) / 60_000).toBe(15);
  });

  it("sendGapMs = interval + random(0, jitter)", () => {
    expect(sendGapMs({ interval_ms: 4000, jitter_ms: 0 }, () => 0.99)).toBe(4000);
    expect(sendGapMs({ interval_ms: 4000, jitter_ms: 2000 }, () => 0)).toBe(4000);
    expect(sendGapMs({ interval_ms: 4000, jitter_ms: 2000 }, () => 1)).toBe(6000);
  });

  it("sleepMs(0) 不排定时器，sleepMs(n) 走原生定时器", async () => {
    vi.useFakeTimers();
    try {
      let resolved = false;
      const immediate = sleepMs(0).then(() => {
        resolved = true;
      });
      await immediate;
      expect(resolved).toBe(true);

      let after = false;
      const pending = sleepMs(1000).then(() => {
        after = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(after).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(after).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
