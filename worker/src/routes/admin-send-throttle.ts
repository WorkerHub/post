import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { setSetting } from "../db/queries/users";
import {
  SEND_THROTTLE_KEY,
  SEND_THROTTLE_LIMITS,
  readSendThrottleConfig,
  validateSendThrottleField,
  type SendThrottleConfig,
} from "../services/send-throttle";

// 发信节流参数的后台接口（节流补遗 §3.1.4）：GET/PUT /api/admin/settings/send-throttle。
//
// v1 不做设置页 UI，管理员可直接改这个接口（与 SMTP 配置同一张表、同一套鉴权口径）。
// 读取一侧永远宽容（库里被写坏 → 逐项回默认 + warn），写入一侧严格（越界/非整数 400），
// 保证经本接口落库的值一定在合法范围内。

export const adminSendThrottleRoutes = new Hono<HonoEnv>();
adminSendThrottleRoutes.use("*", authMiddleware);
adminSendThrottleRoutes.use("*", adminMiddleware);

const THROTTLE_KEYS = [
  "interval_ms",
  "jitter_ms",
  "max_recipients_per_run",
] as const;

adminSendThrottleRoutes.get("/send-throttle", async (c) => {
  const config = await readSendThrottleConfig(c.env.DB, getTablePrefix(c.env));
  return c.json(config);
});

adminSendThrottleRoutes.put("/send-throttle", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  // 未提供的字段保持当前生效值（部分更新），提供的字段必须合法。
  const next: SendThrottleConfig = await readSendThrottleConfig(
    c.env.DB,
    getTablePrefix(c.env),
  );

  for (const key of THROTTLE_KEYS) {
    if (!(key in body)) continue;
    const value = validateSendThrottleField(key, body[key]);
    if (value === null) {
      const { min, max } = SEND_THROTTLE_LIMITS[key];
      return c.json({ error: `${key} 需为 ${min}–${max} 的整数` }, 400);
    }
    next[key] = value;
  }

  await setSetting(
    c.env.DB,
    getTablePrefix(c.env),
    SEND_THROTTLE_KEY,
    JSON.stringify(next),
  );

  return c.json(next);
});
