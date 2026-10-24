import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { HonoEnv } from "../types";
import { verifyJWT } from "../core/auth";

// 移植自 eNotify middleware/auth.ts：HttpOnly Cookie 会话 + JWT + KV 会话/黑名单校验。
// 差异（按 SPEC）：1) 待批准/禁用账号在 login/refresh/2fa 校验时拦截，这里不再重复查库
//（禁用/改角色时 admin 接口会 revokeAllSessions，会话立即失效）；
// 2) 不做管理员 impersonation（SPEC 禁止「模拟登录/代看私信」）。

export async function authMiddleware(c: Context<HonoEnv>, next: Next) {
  const token = getCookie(c, "access_token");

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  if (payload.typ === "refresh") {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const blacklisted = await c.env.KV.get(`bl:${payload.jti}`);
  if (blacklisted) {
    return c.json({ error: "Token revoked" }, 401);
  }

  const sessionOwner = await c.env.KV.get(`ss:${payload.sid}`);
  if (!sessionOwner || sessionOwner !== payload.sub) {
    return c.json({ error: "Session revoked" }, 401);
  }

  c.set("userId", payload.sub);
  c.set("role", payload.role);

  if (payload.needs_2fa_setup) {
    const path = new URL(c.req.url).pathname;
    const exactPaths = ["/api/me", "/api/auth/logout"];
    const prefixPaths = ["/api/auth/2fa/totp/", "/api/auth/2fa/passkey/"];
    const allowed =
      exactPaths.includes(path) || prefixPaths.some((p) => path.startsWith(p));
    if (!allowed) {
      return c.json({ error: "2FA setup required", needs2faSetup: true }, 403);
    }
  }

  await next();
}

// 数据归属校验（SPEC §3）：letters/contacts 一律按 user_id 隔离，
// 后续单的业务路由在查询里用 getAuthUserId(c) 作为 user_id 过滤条件，非本人数据一律 404。
export function getAuthUserId(c: Context<HonoEnv>): string {
  return c.get("userId");
}

export async function adminMiddleware(c: Context<HonoEnv>, next: Next) {
  const role = c.get("role");
  if (role !== "admin") {
    return c.json({ error: "Forbidden: admin access required" }, 403);
  }
  await next();
}

export function rateLimit(opts: {
  max: number;
  window: number;
  keyPrefix: string;
}) {
  return async (c: Context<HonoEnv>, next: Next) => {
    const forwarded = c.req.header("x-forwarded-for");
    const id =
      c.req.header("cf-connecting-ip") ||
      (forwarded ? forwarded.split(",")[0].trim() : "") ||
      "unknown";
    const key = `rl:${opts.keyPrefix}:${id}`;

    const current = await c.env.KV.get(key);
    const count = current ? Number.parseInt(current.split(":")[0], 10) : 0;

    if (count >= opts.max) {
      return c.json({ error: "Too many requests" }, 429);
    }

    const now = Math.floor(Date.now() / 1000);
    if (count === 0) {
      const expiresAt = now + opts.window;
      await c.env.KV.put(key, `1:${expiresAt}`, {
        expirationTtl: Math.max(opts.window, 60),
      });
    } else {
      const parts = (current || "").split(":");
      const expiresAt =
        parts.length >= 2 ? Number.parseInt(parts[1], 10) : now + opts.window;
      const remainingTtl = Math.max(expiresAt - now, 60);
      await c.env.KV.put(key, `${count + 1}:${expiresAt}`, {
        expirationTtl: remainingTtl,
      });
    }
    await next();
  };
}
