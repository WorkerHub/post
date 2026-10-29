import type { Env } from "../types";
import { getTablePrefix, tables } from "../types";
import { getSetting } from "../db/queries/users";
import { senderDomain } from "./smtp-transport";

// Resend 发信通道（对齐 cloud-mail `resendTokens` 的 {域名: token} 通道模式）：
// - 配置存 `system_settings`（与 smtp_config 同表同路）：`mail_channel`（"smtp"|"resend"）
//   与 `resend_tokens`（JSON：{域名: token}）。
// - 发信走 Resend REST API 直连（单收件人单发，不经 SDK，不引入 npm 依赖）。
// - webhook 用 Resend/Svix 签名（HMAC-SHA256），按返回的 Resend 邮件 id 回写 letter_recipients。
//
// 注意：cloud-mail 自身的 resend-service.js 未做 Svix 验签，本文件补上（webhook 是公开入口，
// 必须验签，否则可被伪造事件任意改状态）。

export const MAIL_CHANNEL_KEY = "mail_channel";
export const RESEND_TOKENS_KEY = "resend_tokens";
export const RESEND_SENDER_KEY = "resend_sender";

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const WH_SEC_PREFIX = "whsec_";

export interface ResendSender {
  from: string;
  from_name: string;
}

export interface ResendSendArgs {
  to: string;
  subject: string;
  html: string;
  from: string;
  fromName?: string;
  letterId?: string;
}

export interface ResendSendResult {
  success: boolean;
  error?: string;
  /** 失败时的 Resend HTTP 状态码（供限流分类） */
  code?: number;
  /** 失败时的 Resend 错误原文（与 error 同源，保留给分类/日志） */
  response?: string;
  /** 成功时的 Resend 邮件 id（落库供 webhook 反查） */
  messageId?: string;
  /** 标记结果是 HTTP 通道产生，`classifySendFailure` 按 HTTP 码语义分类 */
  http: true;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

/** 读 {域名: token}，坏值宽容处理（不影响 SMTP 通道与其它路由）。 */
async function readResendTokens(
  env: Env,
): Promise<Record<string, string>> {
  const raw = await getSetting(env.DB, getTablePrefix(env), RESEND_TOKENS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [domain, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof token === "string" && token.trim()) out[domain] = token.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** 读 Resend 渠道的发件身份（from/from_name，与 smtp_config 解耦）。坏值宽容，返回空串。 */
export async function readResendSender(env: Env): Promise<ResendSender> {
  const raw = await getSetting(env.DB, getTablePrefix(env), RESEND_SENDER_KEY);
  if (!raw) return { from: "", from_name: "" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { from: "", from_name: "" };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      from: typeof obj.from === "string" ? obj.from.trim() : "",
      from_name: typeof obj.from_name === "string" ? obj.from_name.trim() : "",
    };
  } catch {
    return { from: "", from_name: "" };
  }
}

/**
 * 经 Resend API 发送单封邮件。成功返回 Resend 邮件 id（`messageId`），
 * 失败返回 HTTP 状态码与错误原文（`code`/`response`/`error`），供上层分类与落库。
 */
export async function sendResendEmail(
  env: Env,
  args: ResendSendArgs,
): Promise<ResendSendResult> {
  const from = clean(args.from);
  if (!from) {
    return { success: false, http: true, error: "Sender not configured" };
  }

  const domain = senderDomain(from);
  const tokens = await readResendTokens(env);
  const token = tokens[domain];
  if (!token) {
    return { success: false, http: true, error: `Resend not configured for domain ${domain}` };
  }

  const payload: Record<string, unknown> = {
    from: args.fromName ? `${args.fromName} <${from}>` : from,
    to: [args.to],
    subject: args.subject,
    html: args.html,
  };
  if (args.letterId !== undefined) {
    payload.headers = { "X-Someday-Letter-Id": args.letterId };
  }

  try {
    const res = await fetch(RESEND_EMAILS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await res.text();
    let body: unknown = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      /* 非 JSON 错误体 */
    }

    if (res.ok) {
      const obj = (body ?? {}) as Record<string, unknown>;
      const id = obj.id ?? (obj.data as Record<string, unknown> | undefined)?.id;
      if (typeof id === "string" && id) {
        return { success: true, http: true, messageId: id };
      }
      return { success: false, http: true, error: "Resend returned no message id" };
    }

    const obj = (body ?? {}) as Record<string, unknown>;
    const message =
      typeof obj.message === "string" && obj.message
        ? obj.message
        : bodyText || `Resend error ${res.status}`;
    return {
      success: false,
      http: true,
      code: res.status,
      response: message,
      error: message,
    };
  } catch (err) {
    return {
      success: false,
      http: true,
      error: `Resend error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── webhook（Svix 签名校验 + 事件映射）──────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resend webhook 的 Svix 签名校验：`HMAC-SHA256(whsec 解码后的密钥, "{svix-id}.{svix-timestamp}.{rawBody}")`，
 * 与 `svix-signature`（形如 `v1,<sig> …`，可能是空格分隔列表）逐段比对。
 * secret 缺失 / 头缺失 / 解密失败一律 false（调用方 fail closed）。
 */
export async function verifyResendSignature(
  secret: string,
  headers: {
    id: string | null | undefined;
    timestamp: string | null | undefined;
    signature: string | null | undefined;
  },
  rawBody: string,
): Promise<boolean> {
  if (!secret || !secret.startsWith(WH_SEC_PREFIX)) return false;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secret.slice(WH_SEC_PREFIX.length));
  } catch {
    return false;
  }
  if (keyBytes.length === 0) return false;

  let expected: string;
  try {
    const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedContent),
    );
    expected = bytesToBase64(new Uint8Array(sig));
  } catch {
    // 密钥格式损坏 / Web Crypto 异常：一律 fail closed（401），不抛 500。
    return false;
  }

  // 只接受带 `v1,` 版本前缀的签名段（Svix 规范）；无前缀或其它版本一律跳过。
  for (const part of headers.signature.split(" ").map((s) => s.trim()).filter(Boolean)) {
    if (!part.startsWith("v1,")) continue;
    const candidate = part.slice(3);
    if (timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** 从 Resend 事件里摘一段可读的原因，供 `letter_recipients.error`。 */
function extractEventError(type: string, data: Record<string, unknown>): string {
  const pick = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  };
  if (type === "email.bounced") {
    const bounce = data.bounce as Record<string, unknown> | undefined;
    if (bounce && typeof bounce === "object") {
      return pick(bounce.message) ?? pick(bounce.type) ?? "bounced";
    }
    return "bounced";
  }
  if (type === "email.failed") {
    const failed = data.failed as Record<string, unknown> | undefined;
    if (failed && typeof failed === "object") {
      return pick(failed.reason) ?? pick(failed.message) ?? "failed";
    }
    const pe = data.provider_error as Record<string, unknown> | undefined;
    if (pe && typeof pe === "object") return pick(pe.message) ?? "failed";
    return "failed";
  }
  if (type === "email.complained") return "complained";
  return "delivery event";
}

export type ResendEventOutcome = "unknown" | "applied" | "noop";

/**
 * 把一条 Resend 投递事件回写到 `letter_recipients`（按 `data.email_id` 反查 `message_id`）。
 * - delivered / delivery_delayed：收件人已 `sent`，无需改动（幂等 noop）。
 * - bounced / failed / complained：把仍处于 `sent` 的收件人翻 `failed` 并记原因；
 *   已非 `sent`（如用户已手动重发）则 noop，不覆盖。
 * 查不到 email_id 返回 "unknown"（调用方记日志返 200，避免 Resend 熔断 webhook）。
 */
export async function applyResendEvent(
  env: Env,
  type: string,
  data: Record<string, unknown>,
): Promise<ResendEventOutcome> {
  const emailId = data.email_id;
  if (typeof emailId !== "string" || !emailId) return "unknown";

  const T = tables(env);
  const row = await env.DB.prepare(
    `SELECT status FROM ${T.letter_recipients} WHERE message_id = ?`,
  )
    .bind(emailId)
    .first<{ status: string }>();
  if (!row) return "unknown";

  if (type === "email.delivered" || type === "email.delivery_delayed") {
    return "noop";
  }

  if (type !== "email.bounced" && type !== "email.failed" && type !== "email.complained") {
    return "noop";
  }

  const error = `[resend] ${extractEventError(type, data)}`;
  const result = await env.DB.prepare(
    `UPDATE ${T.letter_recipients} SET status = 'failed', error = ?, sent_at = NULL WHERE message_id = ? AND status = 'sent'`,
  )
    .bind(error, emailId)
    .run();
  return result.meta?.changes === 1 ? "applied" : "noop";
}
