import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env, HonoEnv } from "./types";

export const app = new Hono<HonoEnv>();

app.use("*", logger());
app.use("*", secureHeaders());

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
