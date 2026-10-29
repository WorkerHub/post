import { Hono } from "hono";
import type { Env, HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { getSetting, setSetting } from "../db/queries/users";
import { hasInjectionChars, isValidEmail } from "../services/email";
import {
  MAIL_CHANNEL_KEY,
  RESEND_TOKENS_KEY,
  RESEND_SENDER_KEY,
  readResendSender,
  sendResendEmail,
  type ResendSender,
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
  sender: ResendSender;
}

async function readState(env: Env): Promise<ResendState> {
  const channel =
    (await getSetting(env.DB, getTablePrefix(env), MAIL_CHANNEL_KEY)) ?? "smtp";
  const raw = await getSetting(env.DB, getTablePrefix(env), RESEND_TOKENS_KEY);
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
  const sender = await readResendSender(env);
  return { channel, tokens, sender };
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
  const { channel, tokens, sender } = await readState(c.env);
  return c.json({
    channel,
    from: sender.from,
    from_name: sender.from_name,
    ...maskedView(tokens),
  });
});

adminResendRoutes.put("/resend", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const existing = await readState(c.env);

  let channel = existing.channel;
  if (body.channel !== undefined) {
    if (typeof body.channel !== "string" || !VALID_CHANNELS.has(body.channel)) {
      return c.json({ error: "发信渠道须为 smtp 或 resend" }, 400);
    }
    channel = body.channel;
  }

  // 发件身份（与 smtp_config 解耦）：from/from_name 至少给一个才更新；
  // from 非空时校验邮箱，from_name 剥注入字符（对齐 SMTP 配置口径）。
  let sender = existing.sender;
  const fromRaw = typeof body.from === "string" ? body.from.trim() : undefined;
  const fromNameRaw =
    typeof body.from_name === "string" ? body.from_name : undefined;
  if (fromRaw !== undefined || fromNameRaw !== undefined) {
    const from = fromRaw ?? existing.sender.from;
    const fromName = (fromNameRaw ?? existing.sender.from_name)
      .replace(/[<>"\r\n]/g, "")
      .trim();
    if (from && (hasInjectionChars(from) || !isValidEmail(from))) {
      return c.json({ error: "发件人邮箱不正确" }, 400);
    }
    sender = { from, from_name: fromName };
  }

  // resend_tokens：以本次提交的域名键整体重建，删域 = 不提交该键即移除。
  // 某域名留空 token = 保留存量（若存在）；提交非空 token = 覆盖该域名。
  let tokens: Record<string, string> = { ...existing.tokens };
  if (body.resend_tokens !== undefined) {
    if (
      typeof body.resend_tokens !== "object" ||
      body.resend_tokens === null ||
      Array.isArray(body.resend_tokens)
    ) {
      return c.json({ error: "resend_tokens 须为 {域名: token} 对象" }, 400);
    }
    const next: Record<string, string> = {};
    for (const [domain, token] of Object.entries(
      body.resend_tokens as Record<string, unknown>,
    )) {
      const d = domain.trim();
      if (!d) continue;
      if (typeof token !== "string") continue;
      const trimmed = token.trim();
      if (trimmed === "") {
        // 留空 = 不改（对齐 SMTP 密码口径）：保留存量 token（若存在）
        const keep = existing.tokens[d];
        if (keep) next[d] = keep;
      } else {
        next[d] = trimmed;
      }
    }
    tokens = next;
  }

  await setSetting(c.env.DB, getTablePrefix(c.env), MAIL_CHANNEL_KEY, channel);
  await setSetting(
    c.env.DB,
    getTablePrefix(c.env),
    RESEND_TOKENS_KEY,
    JSON.stringify(tokens),
  );
  await setSetting(
    c.env.DB,
    getTablePrefix(c.env),
    RESEND_SENDER_KEY,
    JSON.stringify(sender),
  );

  return c.json({
    channel,
    from: sender.from,
    from_name: sender.from_name,
    ...maskedView(tokens),
  });
});

adminResendRoutes.post("/resend/test", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const email =
    body && typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !isValidEmail(email)) {
    return c.json({ error: "请填写有效的测试收件邮箱" }, 400);
  }

  // 发件身份读独立 resend_sender（与 sendEmail 的 resend 分支同口径）。
  const sender = await readResendSender(c.env);

  const result = await sendResendEmail(c.env, {
    to: email,
    subject: "时光邮局测试邮件",
    html: "<p>这是一封来自时光邮局的测试邮件。如果你收到了它，说明 Resend 配置正确。</p>",
    from: sender.from,
    fromName: sender.from_name || "时光邮局",
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error ?? "Resend error" });
  }
  return c.json({ success: true });
});
