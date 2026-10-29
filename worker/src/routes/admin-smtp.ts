import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { getSetting, setSetting } from "../db/queries/users";
import {
  hasInjectionChars,
  isValidEmail,
  isValidSmtpHost,
  parsePort,
  sendEmail,
  type SMTPConfig,
} from "../services/email";

// 管理后台 SMTP 配置与测试邮件（SPEC §8，ONE-176 冻结契约）：
// GET/PUT /api/admin/settings/smtp、POST /api/admin/settings/smtp/test。
// 密码脱敏返回（GET 永不带原文），PUT 留空表示不改；测试邮件即时回显成功/错误原文。

export const adminSmtpRoutes = new Hono<HonoEnv>();
adminSmtpRoutes.use("*", authMiddleware);
adminSmtpRoutes.use("*", adminMiddleware);

const SMTP_KEY = "smtp_config";

const EMPTY_SMTP: SMTPConfig = {
  host: "",
  port: 465,
  username: "",
  password: "",
  from: "",
  from_name: "",
};

async function readConfig(db: D1Database, prefix: string): Promise<SMTPConfig> {
  const raw = await getSetting(db, prefix, SMTP_KEY);
  if (!raw) return { ...EMPTY_SMTP };
  try {
    const parsed: unknown = JSON.parse(raw);
    const obj = (parsed ?? {}) as Record<string, unknown>;
    return {
      host: typeof obj.host === "string" ? obj.host : "",
      port:
        typeof obj.port === "number" ? obj.port : String(obj.port ?? 465),
      username: typeof obj.username === "string" ? obj.username : "",
      password: typeof obj.password === "string" ? obj.password : "",
      from: typeof obj.from === "string" ? obj.from : "",
      from_name: typeof obj.from_name === "string" ? obj.from_name : "",
    };
  } catch {
    return { ...EMPTY_SMTP };
  }
}

function maskConfig(config: SMTPConfig) {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    // 脱敏：永不下发明文密码，password_set 标记是否已配置
    password: "",
    password_set: !!config.password,
    from: config.from,
    from_name: config.from_name,
  };
}

adminSmtpRoutes.get("/smtp", async (c) => {
  const config = await readConfig(c.env.DB, getTablePrefix(c.env));
  return c.json(maskConfig(config));
});

adminSmtpRoutes.put("/smtp", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const existing = await readConfig(c.env.DB, getTablePrefix(c.env));

  const host = typeof body.host === "string" ? body.host.trim() : "";
  if (host && !isValidSmtpHost(host)) {
    return c.json({ error: "SMTP 服务器地址不正确" }, 400);
  }

  const portRaw = body.port !== undefined ? body.port : existing.port;
  const port = parsePort(portRaw as string | number | undefined);
  if (port === null) {
    return c.json({ error: "SMTP 端口不正确" }, 400);
  }

  const username =
    typeof body.username === "string" ? body.username.trim() : existing.username;

  const from = typeof body.from === "string" ? body.from.trim() : existing.from;
  if (from && (hasInjectionChars(from) || !isValidEmail(from))) {
    return c.json({ error: "发件人邮箱不正确" }, 400);
  }

  const fromName = (
    typeof body.from_name === "string" ? body.from_name : existing.from_name
  )
    .replace(/[<>"\r\n]/g, "")
    .trim();

  // 密码脱敏口径：留空表示不改；仅非空字符串更新。
  let password = existing.password;
  if (typeof body.password === "string" && body.password.length > 0) {
    password = body.password;
  }

  const next: SMTPConfig = {
    host,
    port,
    username,
    password,
    from,
    from_name: fromName,
  };
  await setSetting(c.env.DB, getTablePrefix(c.env), SMTP_KEY, JSON.stringify(next));

  return c.json(maskConfig(next));
});

adminSmtpRoutes.post("/smtp/test", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const email =
    body && typeof body.email === "string" ? body.email.trim() : "";

  // 测试邮件：即时发送并回显成功/错误原文（sendEmail 内部做邮箱/配置校验）。
  // 显式 channel: "smtp"，保证 SMTP 测试邮件即便后台切到 Resend 也仍走 SMTP 通道。
  const result = await sendEmail(c.env, {
    to: email,
    subject: "时光邮局测试邮件",
    html: "<p>这是一封来自时光邮局的测试邮件。如果你收到了它，说明 SMTP 配置正确。</p>",
    channel: "smtp",
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error ?? "SMTP error" });
  }
  return c.json({ success: true });
});
