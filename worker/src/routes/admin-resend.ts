import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { getSetting, setSetting } from "../db/queries/users";
import { isValidEmail } from "../services/email";
import {
  MAIL_CHANNEL_KEY,
  RESEND_TOKENS_KEY,
  sendResendEmail,
} from "../services/resend";

// 管理后台 Resend 发信渠道配置（对齐 admin-smtp.ts 的读写与脱敏口径）：
// GET/PUT /api/admin/settings/resend、POST /api/admin/settings/resend/test。
// - `mail_channel`：管理员二选一（"smtp"|"resend"，缺省 "smtp" 与现有行为零变化）。
// - `resend_tokens`：{域名: token} 映射；GET 永不下发 token 明文，PUT 留空 = 不改。

export const adminResendRoutes = new Hono<HonoEnv>();
adminResendRoutes.use("*", authMiddleware);
adminResendRoutes.use("*", adminMiddleware);

const VALID_CHANNELS = new Set(["smtp", "resend"]);

interface ResendState {
  channel: string;
  tokens: Record<string, string>;
}

async function readState(
  db: D1Database,
  prefix: string,
): Promise<ResendState> {
  const channel = (await getSetting(db, prefix, MAIL_CHANNEL_KEY)) ?? "smtp";
  const raw = await getSetting(db, prefix, RESEND_TOKENS_KEY);
  let tokens: Record<string, string> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [domain, token] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof token === "string" && token.trim()) {
            tokens[domain] = token.trim();
          }
        }
      }
    } catch {
      /* 坏值宽容：按空处理 */
    }
  }
  return { channel, tokens };
}

function maskedView(tokens: Record<string, string>) {
  const resend_tokens: Record<string, string> = {};
  const tokens_set: Record<string, boolean> = {};
  for (const domain of Object.keys(tokens)) {
    resend_tokens[domain] = "";
    tokens_set[domain] = true;
  }
  return { resend_tokens, tokens_set };
}

adminResendRoutes.get("/resend", async (c) => {
  const { channel, tokens } = await readState(c.env.DB, getTablePrefix(c.env));
  return c.json({ channel, ...maskedView(tokens) });
});

adminResendRoutes.put("/resend", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const existing = await readState(c.env.DB, getTablePrefix(c.env));

  let channel = existing.channel;
  if (body.channel !== undefined) {
    if (typeof body.channel !== "string" || !VALID_CHANNELS.has(body.channel)) {
      return c.json({ error: "发信渠道须为 smtp 或 resend" }, 400);
    }
    channel = body.channel;
  }

  const tokens: Record<string, string> = { ...existing.tokens };
  if (body.resend_tokens !== undefined) {
    if (
      typeof body.resend_tokens !== "object" ||
      body.resend_tokens === null ||
      Array.isArray(body.resend_tokens)
    ) {
      return c.json({ error: "resend_tokens 须为 {域名: token} 对象" }, 400);
    }
    for (const [domain, token] of Object.entries(
      body.resend_tokens as Record<string, unknown>,
    )) {
      if (typeof token !== "string") continue;
      const trimmed = token.trim();
      // 留空 = 不改（对齐 SMTP 密码口径）；否则覆盖该域名 token。
      if (trimmed === "") continue;
      tokens[domain] = trimmed;
    }
  }

  await setSetting(c.env.DB, getTablePrefix(c.env), MAIL_CHANNEL_KEY, channel);
  await setSetting(
    c.env.DB,
    getTablePrefix(c.env),
    RESEND_TOKENS_KEY,
    JSON.stringify(tokens),
  );

  return c.json({ channel, ...maskedView(tokens) });
});

adminResendRoutes.post("/resend/test", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const email =
    body && typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !isValidEmail(email)) {
    return c.json({ error: "请填写有效的测试收件邮箱" }, 400);
  }

  // 发件身份读 smtp_config（与 sendEmail 的 resend 分支同口径，宽容解析）。
  let from = "";
  let fromName = "";
  const configStr = await getSetting(c.env.DB, getTablePrefix(c.env), "smtp_config");
  if (configStr) {
    try {
      const cfg = JSON.parse(configStr) as Record<string, unknown>;
      from = String(cfg.from ?? "").trim();
      fromName = String(cfg.from_name ?? "").trim();
    } catch {
      /* 坏配置不阻塞测试，交由 sendResendEmail 报 sender 未配置 */
    }
  }

  const result = await sendResendEmail(c.env, {
    to: email,
    subject: "时光邮局测试邮件",
    html: "<p>这是一封来自时光邮局的测试邮件。如果你收到了它，说明 Resend 配置正确。</p>",
    from,
    fromName: fromName || "时光邮局",
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error ?? "Resend error" });
  }
  return c.json({ success: true });
});
