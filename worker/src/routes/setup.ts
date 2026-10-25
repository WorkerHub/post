import { Hono } from "hono";
import type { Env, HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { safeEqual, hashPassword, generateId } from "../core/auth";
import { rateLimit } from "../middleware/auth";
import { isSetupAvailable, closeSetup } from "../lib/setup";
import { SCHEMA_SQL } from "../db/schema";
import {
  countUsers,
  createUserFirstIsAdmin,
  deleteUser,
  findUserByEmail,
  findUserById,
} from "../db/queries/users";
import { publicUser } from "./auth";

// setup 流程（SPEC §3）：首次部署创建第一个账号即管理员，创建后 setup 关闭。
// 安全口径对齐 eNotify：secret 走 X-Setup-Secret 头（不出现在 URL/日志），safeEqual 比较。

export const setupRoutes = new Hono<HonoEnv>();

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Public state endpoint: reports whether the setup page should be shown.
setupRoutes.get("/state", async (c) => {
  const available = await isSetupAvailable(c.env);
  return c.json({ enabled: available });
});

// GET 带 secret 的用法已废弃（eNotify 同款）：secret 不得出现在 URL（浏览器历史/日志/Referer）。
setupRoutes.get("*", (c) => {
  c.header("Allow", "POST");
  return c.json(
    {
      error: "Use POST /api/setup with the X-Setup-Secret header.",
    },
    405,
  );
});

setupRoutes.post(
  "/",
  rateLimit({ max: 3, window: 600, keyPrefix: "setup" }),
  async (c) => {
    // 防守校验（ONE-192 Blocking#2）：占位符/缺失的 SETUP_SECRET 严禁当作有效密钥参与比对，
    // 否则部署带上 [vars] 占位符值时，攻击者回传同值即可越权建号提权。
    const envSecret = c.env.SETUP_SECRET;
    if (!envSecret || envSecret.endsWith("_PLACEHOLDER")) {
      return c.json({ error: "Server misconfigured" }, 500);
    }

    const secret = c.req.header("X-Setup-Secret");
    if (!secret || !(await safeEqual(secret, envSecret))) {
      return c.json({ error: "Invalid setup secret" }, 403);
    }

    if (!(await isSetupAvailable(c.env))) {
      return c.json({ error: "Setup is closed" }, 403);
    }

    const body = await c.req.json<{ email: string; password: string }>();
    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!email || !password) {
      return c.json({ error: "Email and password required" }, 400);
    }
    if (!EMAIL_RE.test(email)) {
      return c.json({ error: "Invalid email format" }, 400);
    }
    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    // 全新部署兜底建表（幂等；不再有独立静态迁移，见 ONE-269 冻结契约第 7 条）
    const prefix = await ensureSchema(c.env);

    const existing = await findUserByEmail(c.env.DB, prefix, email);
    if (existing) {
      return c.json({ error: "Email already registered" }, 409);
    }
    if ((await countUsers(c.env.DB, prefix)) > 0) {
      return c.json({ error: "Setup is closed" }, 403);
    }

    const id = generateId();
    const passwordHash = await hashPassword(password);
    try {
      // 单条语句内原子决定「首个账号 = admin + approved」
      await createUserFirstIsAdmin(c.env.DB, prefix, {
        id,
        email,
        password_hash: passwordHash,
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json({ error: "Email already registered" }, 409);
      }
      throw err;
    }

    // 回读核验（ONE-192 Should-fix）：并发 setup 时后到请求落库为 user/pending，
    // 不得误报 201 成功；顺手清掉本次竞态插入的无用行（id 是本次请求独有的）。
    const user = await findUserById(c.env.DB, prefix, id);
    if (!user || user.role !== "admin") {
      await deleteUser(c.env.DB, prefix, id);
      return c.json({ error: "Setup is closed" }, 403);
    }

    await closeSetup(c.env);

    console.log(`[setup] schema ensured with table prefix "${prefix}"`);
    return c.json({ success: true, table_prefix: prefix, user: publicUser(user) }, 201);
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
