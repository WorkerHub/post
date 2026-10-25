import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import {
  firstMigrationError,
  runMigrations,
  TablePrefixConflictError,
  toSchemaReport,
  type RunMigrationsResult,
} from "../lib/migrations-runner";
import { isSetupPageEnabled, setSetupPageEnabled } from "../lib/setup";
import {
  isRegistrationEnabled,
  setRegistrationEnabled,
} from "../lib/registration";

// 管理后台维护接口：
// 1) POST /api/admin/db-upgrade：程序升级后免 SETUP_SECRET 升级数据库（幂等建表，不依赖任何密钥）；
// 2) GET/POST /api/admin/setup-switch：setup 页面开关（默认 ON，落 {prefix}system_settings）；
// 3) GET/POST /api/admin/registration：注册开关（ONE-330 冻结契约，默认 ON，同一存储）。
// 鉴权复用 admin 路由同款中间件：未登录 401，非管理员 403。

export const adminSystemRoutes = new Hono<HonoEnv>();

adminSystemRoutes.use("*", authMiddleware);
adminSystemRoutes.use("*", adminMiddleware);

// 升级数据库：跑与 POST /api/setup 同一个迁移 runner（账本保证只跑未应用的迁移），
// 不用 SETUP_SECRET、不删不改存量数据。
adminSystemRoutes.post("/db-upgrade", async (c) => {
  let result: RunMigrationsResult;
  try {
    result = await runMigrations(c.env);
  } catch (err) {
    if (err instanceof TablePrefixConflictError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }

  const report = toSchemaReport(result);
  const failed = firstMigrationError(result);
  if (failed) {
    console.error(
      `[admin] db-upgrade failed at ${failed.name}: ${failed.error}`,
    );
    return c.json(
      { success: false, error: `Migration failed: ${failed.name}`, ...report },
      500,
    );
  }

  console.log(
    `[admin] db-upgrade ok: table prefix "${report.table_prefix}", applied ${report.applied}, skipped ${report.skipped}`,
  );
  return c.json({ success: true, ...report });
});

adminSystemRoutes.get("/setup-switch", async (c) => {
  return c.json({ enabled: await isSetupPageEnabled(c.env) });
});

adminSystemRoutes.post("/setup-switch", async (c) => {
  let body: { enabled?: unknown } | null = null;
  try {
    body = await c.req.json<{ enabled?: unknown }>();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  await setSetupPageEnabled(c.env, enabled);
  return c.json({ success: true, enabled });
});

// 注册开关（ONE-330 冻结契约）：默认开启；关闭后 POST /api/auth/register 一律 403。
adminSystemRoutes.get("/registration", async (c) => {
  return c.json({ enabled: await isRegistrationEnabled(c.env) });
});

adminSystemRoutes.post("/registration", async (c) => {
  let body: { enabled?: unknown } | null = null;
  try {
    body = await c.req.json<{ enabled?: unknown }>();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  await setRegistrationEnabled(c.env, enabled);
  return c.json({ success: true, enabled });
});
