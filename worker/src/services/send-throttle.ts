import { getSetting } from "../db/queries/users";

// 发信节流补遗（THROTTLING-ADDENDUM §3.1/§3.2）：节流参数、限流分类、退避时长的唯一定义处。
//
// 参数存 `{prefix}system_settings` 的 `send_throttle_config`（JSON，与 `smtp_config` 同表同路），
// 缺失/字段缺失逐项回默认；非法值（非整数、越界、类型不对）回默认并 warn——投递链路不因配置坏掉而崩。
// `send_paused_until` 是熔断截止时刻（UTC ISO），也放同一张表，本文件只提供键名与读写常量。
//
// 等待一律用运行时原生 `setTimeout`（不是手搓轮询）；分类函数集中在此，发送层只负责把
// SMTP 回复码与原文带回来（见 smtp-transport.ts 的 SmtpResponseError）。

export const SEND_THROTTLE_KEY = "send_throttle_config";
export const SEND_PAUSED_KEY = "send_paused_until";

export interface SendThrottleConfig {
  /** 封间隔基数（毫秒）：上一封投递事务结束后、下一封开始前等待 */
  interval_ms: number;
  /** 在基数上叠加的随机抖动上限（毫秒） */
  jitter_ms: number;
  /** 单轮扫描最多处理的收件人数（按收件人计，不按信计） */
  max_recipients_per_run: number;
}

/** 补遗 §3.1 的默认值（小圈子量级；实测后按日志再调）。 */
export const DEFAULT_SEND_THROTTLE_CONFIG: SendThrottleConfig = {
  interval_ms: 4000,
  jitter_ms: 2000,
  max_recipients_per_run: 10,
};

/** 补遗 §3.1 的合法范围（含端点；越界视为非法值）。 */
export const SEND_THROTTLE_LIMITS: Record<
  keyof SendThrottleConfig,
  { min: number; max: number }
> = {
  interval_ms: { min: 0, max: 30_000 },
  jitter_ms: { min: 0, max: 10_000 },
  max_recipients_per_run: { min: 1, max: 100 },
};

const THROTTLE_KEYS: (keyof SendThrottleConfig)[] = [
  "interval_ms",
  "jitter_ms",
  "max_recipients_per_run",
];

export interface SendThrottleConfigIssue {
  key: keyof SendThrottleConfig;
  reason: string;
}

export interface ParsedSendThrottleConfig {
  config: SendThrottleConfig;
  /** 被判为非法、已回退默认值的字段（缺失字段不算问题，静默回默认） */
  issues: SendThrottleConfigIssue[];
  /** 整段 JSON 不可解析（此时全部字段回默认） */
  invalidJson: boolean;
}

/** 单字段校验：整数且在合法范围内才返回该值，否则 null。 */
export function validateSendThrottleField(
  key: keyof SendThrottleConfig,
  raw: unknown,
): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  const { min, max } = SEND_THROTTLE_LIMITS[key];
  if (raw < min || raw > max) return null;
  return raw;
}

/**
 * 解析存储值：缺失 → 全默认；字段缺失 → 该项默认（静默）；非法 → 该项默认并记入 issues。
 * 管理接口（PUT）复用同一份校验，保证库里不会落非法值。
 */
export function parseSendThrottleConfig(
  raw: string | null,
): ParsedSendThrottleConfig {
  const config: SendThrottleConfig = { ...DEFAULT_SEND_THROTTLE_CONFIG };
  const issues: SendThrottleConfigIssue[] = [];

  if (raw === null || raw.trim() === "") {
    return { config, issues, invalidJson: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config, issues, invalidJson: true };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config, issues, invalidJson: true };
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of THROTTLE_KEYS) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null) continue;
    const value = validateSendThrottleField(key, obj[key]);
    if (value === null) {
      issues.push({ key, reason: `非法值 ${JSON.stringify(obj[key])}，回退默认` });
      continue;
    }
    config[key] = value;
  }

  return { config, issues, invalidJson: false };
}

/** 读生效配置：库里的 `send_throttle_config` → 逐项校验 → 默认值兜底（非法项 warn）。 */
export async function readSendThrottleConfig(
  db: D1Database,
  prefix: string,
): Promise<SendThrottleConfig> {
  const raw = await getSetting(db, prefix, SEND_THROTTLE_KEY);
  const { config, issues, invalidJson } = parseSendThrottleConfig(raw);

  if (invalidJson) {
    console.warn(
      `[send-throttle] ${SEND_THROTTLE_KEY} 不是合法 JSON 对象，全部字段回退默认值`,
    );
  }
  for (const issue of issues) {
    console.warn(`[send-throttle] ${issue.key}: ${issue.reason}`);
  }

  return config;
}

// ─── 限流分类（补遗 §3.2.1）─────────────────────────────────────────────────

export type SendFailureKind = "throttle" | "permanent" | "other";

/** 限流类回复码：临时性拒绝/限流（4yz，421 = 服务暂不可用）。 */
const THROTTLE_CODES = new Set([421, 450, 451, 452]);

/** 永久类回复码：收件人/地址类 5xx，重试无意义。 */
const PERMANENT_CODES = new Set([550, 551, 553]);

/** 限流关键词（大小写不敏感）；集中维护，判类只走本文件。 */
export const THROTTLE_KEYWORDS = [
  "rate",
  "limit",
  "too many",
  "too frequent",
  "temporarily",
  "频繁",
  "限流",
  "超过上限",
] as const;

export interface SendFailureInput {
  /** 发送层带回的 SMTP 回复码（没有则从原文里回解） */
  code?: number | null;
  /** 错误原文（SMTP 回复文本 + 前置说明） */
  text?: string | null;
}

export interface SendFailureClassification {
  kind: SendFailureKind;
  /** 判定所用的回复码（解析不出则为 null） */
  code: number | null;
  /** 错误原文（用于 `letter_recipients.error`） */
  text: string;
}

/**
 * 从错误原文里回解回复码：优先取 `got 452`（trans-protocol 现用错误串形态），
 * 其次取首个 4xx/5xx 三位码。绝不取 `expected 250` 这种期望码——否则会把
 * 「期待 250 实际 550」误读成成功码。
 */
export function extractSmtpCode(text: string): number | null {
  const got = /\bgot\s+(\d{3})\b/i.exec(text);
  if (got?.[1] !== undefined) return Number(got[1]);
  const any = /\b([45]\d{2})\b/.exec(text);
  if (any?.[1] !== undefined) return Number(any[1]);
  return null;
}

/**
 * 错误分类（补遗 §3.2.1）：
 * 1. 回复码优先：421/450/451/452 → throttle；550/551/553 → permanent（码比文本权威）；
 * 2. 无码或码不在两表内，再看关键词（含中文）→ throttle；
 * 3. 其余 → other（维持主规格原有路径：计 attempts，含 `SMTP not configured` 这类配置问题）。
 */
export function classifySendFailure(
  input: SendFailureInput,
): SendFailureClassification {
  const text = String(input.text ?? "");
  const code =
    typeof input.code === "number" && Number.isInteger(input.code)
      ? input.code
      : extractSmtpCode(text);

  if (code !== null && THROTTLE_CODES.has(code)) {
    return { kind: "throttle", code, text };
  }
  if (code !== null && PERMANENT_CODES.has(code)) {
    return { kind: "permanent", code, text };
  }

  const lower = text.toLowerCase();
  if (THROTTLE_KEYWORDS.some((word) => lower.includes(word))) {
    return { kind: "throttle", code, text };
  }

  return { kind: "other", code, text };
}

/** `[throttle:452] 原文` / `[permanent:550] 原文` / `[other] 原文`。 */
export function formatDeliveryError(
  classification: Pick<SendFailureClassification, "kind" | "code" | "text">,
): string {
  const tag =
    classification.code === null
      ? `[${classification.kind}]`
      : `[${classification.kind}:${classification.code}]`;
  return `${tag} ${classification.text}`;
}

// ─── 退避时长（补遗 §3.2.2）─────────────────────────────────────────────────

/** 退避序列：15 → 30 → 60 分钟，第 3 次之后封顶 60 分钟重复。 */
export const THROTTLE_BACKOFF_MINUTES = [15, 30, 60] as const;

/** `throttleAttempts` = 本次退避后的计数（从 1 起）。 */
export function throttleBackoffMs(throttleAttempts: number): number {
  const index = Math.min(
    Math.max(Math.trunc(throttleAttempts), 1),
    THROTTLE_BACKOFF_MINUTES.length,
  ) - 1;
  return THROTTLE_BACKOFF_MINUTES[index]! * 60_000;
}

// ─── 间隔等待 / 配置校验辅助 ─────────────────────────────────────────────────

/** 原生定时器等待；0 或负数直接返回（配置允许 interval/jitter 为 0）。 */
export function sleepMs(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 本封与下一封之间的间隔：`interval_ms + random(0, jitter_ms)`。 */
export function sendGapMs(
  config: Pick<SendThrottleConfig, "interval_ms" | "jitter_ms">,
  random: () => number = Math.random,
): number {
  const jitter = Math.floor(random() * (config.jitter_ms + 1));
  return config.interval_ms + Math.min(Math.max(jitter, 0), config.jitter_ms);
}
