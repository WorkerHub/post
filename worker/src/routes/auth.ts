import { Hono, type Context } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { HonoEnv, JWTPayload, User } from "../types";
import {
  hashPassword,
  verifyPassword,
  signJWT,
  verifyJWT,
  generateId,
  generateJti,
} from "../core/auth";
import {
  createUser,
  createUserFirstIsAdmin,
  findUserByEmail,
  findUserById,
  get2FAConfig,
  countUsers,
} from "../db/queries/users";
import { getAvailable2FAMethods } from "../services/twofa";
import { rateLimit } from "../middleware/auth";

// 移植自 eNotify routes/auth.ts：HttpOnly Cookie + JWT 双 token（access 24h / refresh 7d）、
// KV 会话索引/黑名单、登录防时序侧信道、限流参数全部同款。
// 差异（按 SPEC §3）：注册开放但新账号默认 pending，登录/刷新时拒绝待批准账号；
// 不做邮箱验证与密码找回邮件（v1 全局 SMTP 在后续单接入，届时再评估补齐）。

export const authRoutes = new Hono<HonoEnv>();

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

authRoutes.use(
  "/login",
  rateLimit({ max: 10, window: 300, keyPrefix: "login" }),
);
authRoutes.use(
  "/register",
  rateLimit({ max: 5, window: 300, keyPrefix: "register" }),
);
authRoutes.use(
  "/refresh",
  rateLimit({ max: 20, window: 300, keyPrefix: "refresh" }),
);

// ─── register：开放注册，一律 role=user + 待批准 ────────────────────────────

authRoutes.post("/register", async (c) => {
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

  // 首个账号必须走 setup（X-Setup-Secret）创建，开放注册永不产生管理员
  if ((await countUsers(c.env.DB)) === 0) {
    return c.json({ error: "Setup required before registration" }, 403);
  }

  const existing = await findUserByEmail(c.env.DB, email);
  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const id = generateId();
  const passwordHash = await hashPassword(password);

  try {
    await createUser(c.env.DB, {
      id,
      email,
      password_hash: passwordHash,
      role: "user",
      approval_status: "pending",
    });
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return c.json({ error: "Email already registered" }, 409);
    }
    throw err;
  }

  // 待批准账号不签发会话，等管理员批准后再登录
  return c.json(
    {
      success: true,
      message: "Registration successful. Please wait for admin approval.",
      pending: true,
    },
    201,
  );
});

// ─── login ───────────────────────────────────────────────────────────────────

authRoutes.post("/login", async (c) => {
  const { email, password } = await c.req.json<{
    email: string;
    password: string;
  }>();

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const user = await findUserByEmail(c.env.DB, email);
  if (!user) {
    // 防时序侧信道：对不存在账号也跑一次哈希（eNotify 同款）
    await verifyPassword(
      password,
      "0000000000000000000000000000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000",
    );
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  if (!user.is_active) {
    return c.json({ error: "Account is disabled" }, 403);
  }

  // SPEC §3：待批准账号不能登录使用
  if (user.approval_status !== "approved") {
    return c.json({ error: "Account pending approval", pending: true }, 403);
  }

  const twoFAConfig = await get2FAConfig(c.env.DB, user.id);
  const methods = getAvailable2FAMethods(twoFAConfig);

  if (methods.length > 0) {
    const tempToken = generateId();
    await c.env.KV.put(`2fa:${tempToken}`, user.id, { expirationTtl: 300 });
    return c.json({
      requires2fa: true,
      tempToken,
      availableMethods: methods,
    });
  }

  await issueTokens(c, user.id, user.role);
  return c.json({
    success: true,
    user: publicUser(user),
  });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, "access_token");
  if (token) {
    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    if (payload) {
      const remaining = payload.exp - Math.floor(Date.now() / 1000);
      if (remaining > 0) {
        await c.env.KV.put(`bl:${payload.jti}`, "1", {
          expirationTtl: Math.max(remaining, 60),
        });
      }
    }
  }

  const refreshTokenStr = getCookie(c, "refresh_token");
  if (refreshTokenStr) {
    const payload = await verifyJWT(refreshTokenStr, c.env.JWT_SECRET);
    if (payload) {
      await c.env.KV.delete(`rt:${payload.jti}`);
      await c.env.KV.delete(`ss:${payload.sid}`);
      if (payload.sub) {
        await removeSessionIndex(c.env.KV, payload.sub, payload.jti);
      }
    }
  }

  deleteCookie(c, "access_token", { path: "/" });
  deleteCookie(c, "refresh_token", { path: "/" });

  return c.json({ success: true });
});

authRoutes.post("/refresh", async (c) => {
  const refreshTokenStr = getCookie(c, "refresh_token");
  if (!refreshTokenStr) {
    return c.json({ error: "No refresh token" }, 401);
  }

  const payload = await verifyJWT(refreshTokenStr, c.env.JWT_SECRET);
  if (!payload || payload.typ === "access") {
    return c.json({ error: "Invalid refresh token" }, 401);
  }

  const sessionOwner = await c.env.KV.get(`ss:${payload.sid}`);
  if (!sessionOwner || sessionOwner !== payload.sub) {
    return c.json({ error: "Session revoked" }, 401);
  }

  const stored = await c.env.KV.get(`rt:${payload.jti}`);
  if (!stored) {
    return c.json({ error: "Refresh token revoked" }, 401);
  }

  // Short grace period so concurrent refreshes (multiple tabs) don't log the user out.
  await c.env.KV.put(`rt:${payload.jti}`, stored, { expirationTtl: 60 });
  await removeSessionIndex(c.env.KV, payload.sub, payload.jti);

  const user = await findUserById(c.env.DB, payload.sub);
  if (!user || !user.is_active) {
    return c.json({ error: "User not found or disabled" }, 401);
  }
  if (user.approval_status !== "approved") {
    return c.json({ error: "Account pending approval" }, 403);
  }

  await issueTokens(c, user.id, user.role, false, payload.sid);
  return c.json({ success: true });
});

// ─── token 签发与会话索引（eNotify 同款） ────────────────────────────────────

export async function issueTokens(
  c: Context<HonoEnv>,
  userId: string,
  role: string,
  needs2faSetup = false,
  existingSid?: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const sid = existingSid || generateId();
  const accessJti = generateJti();
  const refreshJti = generateJti();

  const accessPayload: JWTPayload = {
    typ: "access",
    sub: userId,
    role,
    jti: accessJti,
    sid,
    iat: now,
    exp: now + 86400, // 24h
    ...(needs2faSetup ? { needs_2fa_setup: true } : {}),
  };

  const refreshPayload: JWTPayload = {
    typ: "refresh",
    sub: userId,
    role,
    jti: refreshJti,
    sid,
    iat: now,
    exp: now + 604800, // 7d
  };

  const accessToken = await signJWT(accessPayload, c.env.JWT_SECRET);
  const refreshTokenStr = await signJWT(refreshPayload, c.env.JWT_SECRET);

  await c.env.KV.put(`rt:${refreshJti}`, userId, { expirationTtl: 604800 });
  await c.env.KV.put(`ss:${sid}`, userId, { expirationTtl: 604800 });

  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const ua = c.req.header("user-agent") || "unknown";
  await addSessionIndex(c.env.KV, userId, {
    jti: refreshJti,
    sid,
    iat: now,
    exp: now + 604800,
    ip,
    ua,
  });

  setCookie(c, "access_token", accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 86400,
  });

  setCookie(c, "refresh_token", refreshTokenStr, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 604800,
  });
}

export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    is_active: !!user.is_active,
    approval_status: user.approval_status,
    display_name: user.display_name,
    timezone: user.timezone,
    language: user.language,
    created_at: user.created_at,
  };
}

// ── Session index helpers（eNotify 同款） ────────────────────────────────────

interface SessionEntry {
  jti: string;
  sid: string;
  iat: number;
  exp: number;
  ip?: string;
  ua?: string;
}

export async function addSessionIndex(
  kv: KVNamespace,
  userId: string,
  entry: SessionEntry,
): Promise<void> {
  const key = `sessions:${userId}`;
  const raw = await kv.get(key);
  const sessions: SessionEntry[] = raw ? JSON.parse(raw) : [];
  sessions.push(entry);
  await kv.put(key, JSON.stringify(sessions), { expirationTtl: 604800 });
}

export async function removeSessionIndex(
  kv: KVNamespace,
  userId: string,
  jti: string,
): Promise<void> {
  const key = `sessions:${userId}`;
  const raw = await kv.get(key);
  if (!raw) return;
  const sessions: SessionEntry[] = JSON.parse(raw);
  const filtered = sessions.filter((s) => s.jti !== jti);
  if (filtered.length === 0) {
    await kv.delete(key);
  } else {
    await kv.put(key, JSON.stringify(filtered), { expirationTtl: 604800 });
  }
}

export async function revokeAllSessions(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  const key = `sessions:${userId}`;
  const raw = await kv.get(key);
  if (!raw) return;
  const sessions: SessionEntry[] = JSON.parse(raw);
  await Promise.all(
    sessions.flatMap((s) => [
      kv.delete(`rt:${s.jti}`),
      kv.delete(`ss:${s.sid}`),
    ]),
  );
  await kv.delete(key);
}

export async function getSessionIndex(
  kv: KVNamespace,
  userId: string,
): Promise<SessionEntry[]> {
  const key = `sessions:${userId}`;
  const raw = await kv.get(key);
  if (!raw) return [];
  const sessions: SessionEntry[] = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  return sessions.filter((s) => s.exp > now);
}
