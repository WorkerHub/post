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

// SPA fallback: serve static assets, fall back to index.html for client-side routing
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw));
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
