import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env, HonoEnv } from "./types";
import { setupRoutes } from "./routes/setup";
import { authRoutes } from "./routes/auth";
import { auth2faRoutes } from "./routes/auth2fa";
import { meRoutes } from "./routes/me";
import { adminRoutes } from "./routes/admin";

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

// eNotify 同款：JWT_SECRET 未配置/过短/占位符时拒绝 API 服务
app.use("/api/*", async (c, next) => {
  const secret = c.env.JWT_SECRET;
  if (!secret || secret.length < 16 || secret.endsWith("_PLACEHOLDER")) {
    console.error("JWT_SECRET is missing, too short, or still a placeholder");
    return c.json({ error: "Server misconfigured" }, 500);
  }
  await next();
});

app.route("/api/setup", setupRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/auth/2fa", auth2faRoutes);
app.route("/api/me", meRoutes);
app.route("/api/admin", adminRoutes);

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// API 兜底：未知接口统一返回 JSON 404，不能落到 SPA 的 index.html。
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

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
 * 占位实现：调度扫描与抢占发送逻辑在后续任务中实现。
 */
export async function handleScheduled(_env: Env): Promise<void> {
  // no-op placeholder
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
