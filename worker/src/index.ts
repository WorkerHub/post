import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env, HonoEnv } from "./types";
import { setupRoutes } from "./routes/setup";
import { authRoutes } from "./routes/auth";
import { auth2faRoutes } from "./routes/auth2fa";
import { meRoutes } from "./routes/me";
import { adminRoutes } from "./routes/admin";
import { lettersRoutes } from "./routes/letters";
import { contactsRoutes } from "./routes/contacts";
import { publicRoutes } from "./routes/public";
import { adminSmtpRoutes } from "./routes/admin-smtp";
import { adminSystemRoutes } from "./routes/admin-system";
import { wakerCallbackRoutes } from "./routes/waker-callback";
import { processDueLetters } from "./services/scheduler";
import { CALLBACK_MOUNT_PATH } from "./waker";

export const app = new Hono<HonoEnv>();

app.use("*", logger());
app.use("*", secureHeaders());

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  if (err instanceof SyntaxError) {
    return c.json({ error: "Invalid request body" }, 400);
  }
  return c.json({ error: "Internal server error" }, 500);
});

// eNotify 同款 fail-safe + 占位符防绕过（ONE-192 Blocking）：敏感密钥未配置/过短/含占位符时
// 拒绝全部 API 服务。密钥只能来自 wrangler secret（线上）或 .dev.vars（本地），不得是 [vars] 占位符。
app.use("/api/*", async (c, next) => {
  const secrets: [string, string | undefined][] = [
    ["JWT_SECRET", c.env.JWT_SECRET],
    ["SETUP_SECRET", c.env.SETUP_SECRET],
  ];
  for (const [name, secret] of secrets) {
    if (
      !secret ||
      secret.length < 16 ||
      secret.endsWith("_PLACEHOLDER")
    ) {
      console.error(
        `${name} is missing, too short, or still a placeholder`,
      );
      return c.json({ error: "Server misconfigured" }, 500);
    }
  }
  await next();
});

app.route("/api/setup", setupRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/auth/2fa", auth2faRoutes);
app.route("/api/me", meRoutes);
// 冻结契约（ONE-176）设置路由：与 /api/me 同源，昵称/时区/语言/会话。
app.route("/api/settings/me", meRoutes);
app.route("/api/letters", lettersRoutes);
app.route("/api/contacts", contactsRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/admin/settings", adminSmtpRoutes);
// ONE-319 管理后台维护接口：升级数据库 + setup 页面开关（管理员会话鉴权）。
app.route("/api/admin", adminSystemRoutes);
app.route("/api/admin", adminRoutes);

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// API 兜底：未知接口统一返回 JSON 404，不能落到 SPA 的 index.html。
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// waker 回调入口（ONE-566）：平台同步 POST `/_waker/execute` → processDueLetters(env) → 统计。
// 与 /api/* 完全隔离（不走 API 的 fail-safe 中间件），验签/幂等/错误码全在 SDK 的 receiver 里。
// 自有 cron 本单不动，摘除是后续阶段。
app.route(CALLBACK_MOUNT_PATH, wakerCallbackRoutes());

// SPA fallback: serve static assets, fall back to index.html for client-side routing.
// ASSETS.fetch 返回的 Response 头不可变，会被 secureHeaders 改写时报错，
// 这里复制为可变头的新 Response 后再交给中间件。
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const finalRes =
    res.status === 404
      ? await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw))
      : res;
  return new Response(finalRes.body, finalRes);
});

/**
 * 定时任务入口（cron 每 5 分钟一次，见 wrangler.toml）。
 * SPEC §5：扫 status='scheduled' AND send_at<=now，D1 状态抢占 + 逐收件人投递。
 */
export async function handleScheduled(env: Env): Promise<void> {
  try {
    const stats = await processDueLetters(env);
    console.info("scheduled delivery run:", stats);
  } catch (err) {
    console.error("scheduled delivery failed:", err);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
