import { Hono } from "hono";
import type { Env, HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { safeEqual } from "../core/auth";
import { rateLimit } from "../middleware/auth";
import { isSetupAvailable, closeSetup } from "../lib/setup";
import { SCHEMA_SQL } from "../db/schema";

// setup 流程（ONE-313 冻结契约）：可视化 setup 页只填 SETUP_SECRET 完成初始化，
// 不再建任何账号；初始化完成后，第一个通过页面注册的用户成为管理员（见 routes/auth.ts）。
// 安全口径：secret 走请求体（不进 URL/日志），用 safeEqual 比较；SETUP_SECRET 不落日志。

export const setupRoutes = new Hono<HonoEnv>();

// Public state endpoint: reports whether the setup page should be shown.
setupRoutes.get("/state", async (c) => {
  const available = await isSetupAvailable(c.env);
  return c.json({ enabled: available });
});

// GET 携带 secret 的用法不做（secret 不得出现在 URL：浏览器历史/日志/Referer）。
setupRoutes.get("*", (c) => {
  c.header("Allow", "POST");
  return c.json(
    {
      error: "Use POST /api/setup with a JSON body: { setup_secret }.",
    },
    405,
  );
});

setupRoutes.post(
  "/",
  rateLimit({ max: 3, window: 600, keyPrefix: "setup" }),
  async (c) => {
    // 防守校验（ONE-192 Blocking#2）：占位符/缺失的 SETUP_SECRET 严禁当作有效密钥参与比对，
    // 否则部署带上 [vars] 占位符值时，攻击者回传同值即可完成初始化。
    const envSecret = c.env.SETUP_SECRET;
    if (!envSecret || envSecret.endsWith("_PLACEHOLDER")) {
      return c.json({ error: "Server misconfigured" }, 500);
    }

    let body: { setup_secret?: unknown } | null = null;
    try {
      body = await c.req.json<{ setup_secret?: unknown }>();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const secret = body?.setup_secret;
    if (
      typeof secret !== "string" ||
      !secret ||
      !(await safeEqual(secret, envSecret))
    ) {
      return c.json({ error: "Invalid setup secret" }, 403);
    }

    if (!(await isSetupAvailable(c.env))) {
      return c.json({ error: "Setup is closed" }, 403);
    }

    // 全新部署兜底建表（幂等；不再有独立静态迁移，见 ONE-269 冻结契约第 7 条）。
    // 必须先建表再 closeSetup（后者写 system_settings）。
    const prefix = await ensureSchema(c.env);

    await closeSetup(c.env);

    console.log(`[setup] initialized, schema ensured with table prefix "${prefix}"`);
    return c.json({ success: true });
  },
);

/** 按生效前缀替换 {prefix} 后建表（幂等），并返回实际生效前缀。 */
export async function ensureSchema(env: Env): Promise<string> {
  const prefix = getTablePrefix(env);
  const resolved = SCHEMA_SQL.replace(/\{prefix\}/g, prefix);
  const statements = resolved
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
  return prefix;
}
