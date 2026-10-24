import type { Env } from "../types";
import { getSetting } from "../db/queries/users";
import { sendSmtpMessage } from "./smtp-transport";

// 系统邮件抽象（SPEC §2/§5，照 eNotify 现行 main `services/email.ts` 的系统邮件路径）。
// 配置读 D1 `system_settings` 的 `smtp_config`（JSON：host/port/username/password/from/from_name）。
// v1 只实现 smtp 分支；抽象签名保留，日后可加 Resend。
// 输入校验照 eNotify `services/notify/email-notify.ts`：host 正则、邮箱正则、
// 收发地址与主题的 CRLF/注入字符拦截、端口解析。

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && !email.includes("\r") && !email.includes("\n");
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  fromName?: string;
}

export interface SMTPConfig {
  host: string;
  port: number | string;
  username: string;
  password: string;
  from: string;
  from_name: string;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

/** `port` may be stored as a string in the JSON config; SMTP needs a number. */
export function parsePort(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * Header/envelope injection guards. `to` and `from` both end up verbatim in
 * `MAIL FROM:`/`RCPT TO:` and in message headers, so they are validated the
 * same way.
 */
export function hasInjectionChars(value: string): boolean {
  return /[\r\n,;<>]/.test(value);
}

/** Conservative hostname / IPv4 / bracketed IPv6 check (no spaces, no userinfo). */
export function isValidSmtpHost(host: string): boolean {
  return /^[A-Za-z0-9._\-:[\]]+$/.test(host);
}

export async function sendEmail(
  env: Env,
  options: EmailOptions,
): Promise<{ success: boolean; error?: string }> {
  const to = clean(options.to);
  if (!to) {
    return { success: false, error: "Invalid recipient email address" };
  }
  if (hasInjectionChars(to) || !isValidEmail(to)) {
    return { success: false, error: "Invalid recipient email address" };
  }

  const configStr = await getSetting(env.DB, "smtp_config");
  if (!configStr) {
    return { success: false, error: "SMTP not configured" };
  }

  let config: SMTPConfig;
  try {
    config = JSON.parse(configStr);
  } catch {
    return { success: false, error: "Invalid SMTP config" };
  }

  const host = clean(config.host);
  if (!host) {
    return { success: false, error: "SMTP host not configured" };
  }
  if (!isValidSmtpHost(host)) {
    return { success: false, error: "Invalid SMTP host" };
  }

  const port = parsePort(config.port);
  if (port === null) {
    return { success: false, error: "Invalid SMTP port" };
  }

  const username = clean(config.username);
  const password = config.password ?? "";

  // `from` 来自 options（调用方显式指定）或全局 smtp_config；两者都不得注入。
  const from = clean(options.from) || clean(config.from) || username;
  if (!from) {
    return { success: false, error: "SMTP sender not configured" };
  }
  if (hasInjectionChars(from) || !isValidEmail(from)) {
    return { success: false, error: "Invalid SMTP sender address" };
  }

  const fromName = clean(options.fromName || config.from_name || "时光邮局")
    .replace(/[<>"\r\n]/g, "")
    .trim();
  const subject = (options.subject || "").replace(/[\r\n]+/g, " ").trim();

  // transport 层（connect 在 try 外）可能同步抛错（如非法参数），
  // 这里兜底成 { success: false }，保证调用方永远拿到结果、不会把信卡在 sending。
  try {
    return await sendSmtpMessage(
      { host, port, username, password },
      {
        to,
        subject,
        html: options.html,
        from,
        fromName: fromName || undefined,
      },
    );
  } catch (err) {
    return {
      success: false,
      error: `SMTP error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
