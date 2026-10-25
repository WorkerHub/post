import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { HonoEnv, JWTPayload } from "../types";
import { getTablePrefix } from "../types";
import { authMiddleware, rateLimit } from "../middleware/auth";
import { findUserById, updateUser, get2FAConfig } from "../db/queries/users";
import {
  hashPassword,
  verifyPassword,
  generateId,
  generateJti,
  signJWT,
  verifyJWT,
} from "../core/auth";
import {
  getSessionIndex,
  removeSessionIndex,
  addSessionIndex,
  revokeAllSessions,
} from "./auth";

// 移植自 eNotify routes/me.ts 的用户自服务子集（SPEC §8）：
// 昵称（display_name，公开墙显示用）、时区、语言（zh/en）、改密码、会话管理。

export const meRoutes = new Hono<HonoEnv>();

meRoutes.use("*", authMiddleware);
meRoutes.use(
  "/password",
  rateLimit({ max: 5, window: 300, keyPrefix: "pwd_change" }),
);

meRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const prefix = getTablePrefix(c.env);
  const user = await findUserById(c.env.DB, prefix, userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  const twoFA = await get2FAConfig(c.env.DB, prefix, userId);

  return c.json({
    id: user.id,
    email: user.email,
    role: user.role,
    is_active: !!user.is_active,
    approval_status: user.approval_status,
    display_name: user.display_name,
    timezone: user.timezone,
    language: user.language,
    created_at: user.created_at,
    twofa: {
      totp_enabled: !!twoFA?.totp_enabled,
      passkey_enabled: !!twoFA?.passkey_enabled,
      preferred_method: twoFA?.preferred_method || null,
    },
  });
});

meRoutes.put("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    display_name?: string;
    timezone?: string;
    language?: string;
  }>();

  const updates: Record<string, unknown> = {};
  if (body.display_name !== undefined) {
    const name = String(body.display_name).trim();
    if (name.length > 50)
      return c.json({ error: "Display name must be at most 50 characters" }, 400);
    updates.display_name = name;
  }
  if (body.timezone !== undefined) {
    if (!body.timezone)
      return c.json({ error: "Invalid timezone" }, 400);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: String(body.timezone) });
    } catch {
      return c.json({ error: "Invalid timezone" }, 400);
    }
    updates.timezone = body.timezone;
  }
  if (body.language !== undefined) {
    if (!["zh", "en"].includes(body.language))
      return c.json({ error: "Invalid language" }, 400);
    updates.language = body.language;
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  await updateUser(c.env.DB, getTablePrefix(c.env), userId, updates);
  return c.json({ success: true });
});

meRoutes.put("/password", async (c) => {
  const userId = c.get("userId");
  const { currentPassword, newPassword } = await c.req.json<{
    currentPassword: string;
    newPassword: string;
  }>();

  if (!currentPassword || !newPassword) {
    return c.json({ error: "Current and new password required" }, 400);
  }

  if (newPassword.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const user = await findUserById(c.env.DB, getTablePrefix(c.env), userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) return c.json({ error: "Current password is incorrect" }, 401);

  const hash = await hashPassword(newPassword);
  await updateUser(c.env.DB, getTablePrefix(c.env), userId, { password_hash: hash });

  // Invalidate current access token
  const accessTokenStr = getCookie(c, "access_token");
  if (accessTokenStr) {
    const payload = await verifyJWT(accessTokenStr, c.env.JWT_SECRET);
    if (payload) {
      const remaining = payload.exp - Math.floor(Date.now() / 1000);
      if (remaining > 0) {
        await c.env.KV.put(`bl:${payload.jti}`, "1", {
          expirationTtl: Math.max(remaining, 60),
        });
      }
    }
  }

  // Invalidate current refresh token
  const refreshTokenStr = getCookie(c, "refresh_token");
  if (refreshTokenStr) {
    const rtPayload = await verifyJWT(refreshTokenStr, c.env.JWT_SECRET);
    if (rtPayload) {
      await c.env.KV.delete(`rt:${rtPayload.jti}`);
      await c.env.KV.delete(`ss:${rtPayload.sid}`);
      await removeSessionIndex(c.env.KV, userId, rtPayload.jti);
    }
  }

  // Issue new tokens
  await revokeAllSessions(c.env.KV, userId);
  const now = Math.floor(Date.now() / 1000);
  const sid = generateId();
  const newAccessJti = generateJti();
  const newRefreshJti = generateJti();

  const accessPayload: JWTPayload = {
    typ: "access",
    sub: userId,
    role: user.role,
    jti: newAccessJti,
    sid,
    iat: now,
    exp: now + 86400,
  };
  const refreshPayload: JWTPayload = {
    typ: "refresh",
    sub: userId,
    role: user.role,
    jti: newRefreshJti,
    sid,
    iat: now,
    exp: now + 604800,
  };

  const newAccessToken = await signJWT(accessPayload, c.env.JWT_SECRET);
  const newRefreshToken = await signJWT(refreshPayload, c.env.JWT_SECRET);

  await c.env.KV.put(`rt:${newRefreshJti}`, userId, { expirationTtl: 604800 });
  await c.env.KV.put(`ss:${sid}`, userId, { expirationTtl: 604800 });
  // Track new session in KV index
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const ua = c.req.header("user-agent") || "unknown";
  await addSessionIndex(c.env.KV, userId, {
    jti: newRefreshJti,
    sid,
    iat: now,
    exp: now + 604800,
    ip,
    ua,
  });

  setCookie(c, "access_token", newAccessToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 86400,
  });
  setCookie(c, "refresh_token", newRefreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 604800,
  });

  return c.json({ success: true });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

meRoutes.get("/sessions", async (c) => {
  const userId = c.get("userId");
  const sessions = await getSessionIndex(c.env.KV, userId);

  // Identify current session from refresh token
  let currentJti: string | undefined;
  const refreshTokenStr = getCookie(c, "refresh_token");
  if (refreshTokenStr) {
    const payload = await verifyJWT(refreshTokenStr, c.env.JWT_SECRET);
    if (payload) currentJti = payload.jti;
  }

  // Verify each session's refresh token still exists in KV (may have been revoked)
  const validSessions = [];
  for (const s of sessions) {
    const refreshOwner = await c.env.KV.get(`rt:${s.jti}`);
    const sessionOwner = await c.env.KV.get(`ss:${s.sid}`);
    if (refreshOwner === userId && sessionOwner === userId) {
      validSessions.push({
        jti: s.jti,
        iat: s.iat,
        exp: s.exp,
        ip: s.ip,
        ua: s.ua,
        current: s.jti === currentJti,
      });
    }
  }

  // Clean up stale entries from the index
  const validJtis = new Set(validSessions.map((s) => s.jti));
  const staleJtis = sessions.filter((s) => !validJtis.has(s.jti));
  if (staleJtis.length > 0) {
    const key = `sessions:${userId}`;
    const remaining = sessions.filter((s) => validJtis.has(s.jti));
    if (remaining.length === 0) {
      await c.env.KV.delete(key);
    } else {
      await c.env.KV.put(key, JSON.stringify(remaining), {
        expirationTtl: 604800,
      });
    }
  }

  return c.json(validSessions);
});

meRoutes.delete("/sessions/:jti", async (c) => {
  const userId = c.get("userId");
  const jti = c.req.param("jti");

  // Don't allow revoking current session via this endpoint (use logout instead)
  const refreshTokenStr = getCookie(c, "refresh_token");
  if (refreshTokenStr) {
    const payload = await verifyJWT(refreshTokenStr, c.env.JWT_SECRET);
    if (payload && payload.jti === jti) {
      return c.json({ error: "Use logout to end current session" }, 400);
    }
  }

  // Verify the session belongs to this user
  const sessions = await getSessionIndex(c.env.KV, userId);
  const target = sessions.find((s) => s.jti === jti);
  if (!target) return c.json({ error: "Session not found" }, 404);

  // Revoke: delete refresh token from KV
  await c.env.KV.delete(`rt:${jti}`);
  await c.env.KV.delete(`ss:${target.sid}`);

  // Remove from session index
  await removeSessionIndex(c.env.KV, userId, jti);

  return c.json({ success: true });
});
