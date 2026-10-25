import { Hono, type Context } from "hono";
import type { HonoEnv, JWTPayload } from "../types";
import { getTablePrefix } from "../types";
import { authMiddleware, rateLimit } from "../middleware/auth";
import { get2FAConfig, upsert2FAConfig, findUserById } from "../db/queries/users";
import {
  generateTOTPSecret,
  verifyTOTPAsync,
} from "../services/twofa";
import { signJWT, generateId, generateJti, verifyPassword } from "../core/auth";
import { addSessionIndex, publicUser } from "./auth";
import { setCookie } from "hono/cookie";

// 移植自 eNotify routes/auth2fa.ts：TOTP + Passkey（@simplewebauthn/server）。
// 差异：email_otp 方法不开放（v1 无全局 SMTP 前无法发信，SMTP 层在后续单接入）。

interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
}

export const auth2faRoutes = new Hono<HonoEnv>();

// Sensitive 2FA changes require re-entering the account password.
async function requirePassword(
  c: Context<HonoEnv>,
  password: unknown,
): Promise<Response | null> {
  if (typeof password !== "string" || !password) {
    return c.json({ error: "Password required" }, 400);
  }
  const userId = c.get("userId");
  const user = await findUserById(c.env.DB, getTablePrefix(c.env), userId);
  if (!user) return c.json({ error: "User not found" }, 404);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return c.json({ error: "Password is incorrect" }, 403);
  return null;
}

async function readPassword(c: Context<HonoEnv>): Promise<unknown> {
  const body = await c.req.json<{ password?: string }>().catch(() => null);
  return body?.password;
}

auth2faRoutes.use(
  "/verify",
  rateLimit({ max: 5, window: 300, keyPrefix: "2fa" }),
);

// Verify 2FA during login (no auth middleware - uses tempToken)
auth2faRoutes.post("/verify", async (c) => {
  const { tempToken, method, code } = await c.req.json<{
    tempToken: string;
    method: string;
    code: string;
  }>();

  if (!tempToken || !method || !code) {
    return c.json({ error: "tempToken, method, and code required" }, 400);
  }

  const userId = await c.env.KV.get(`2fa:${tempToken}`);
  if (!userId) {
    return c.json({ error: "Invalid or expired 2FA session" }, 401);
  }

  const prefix = getTablePrefix(c.env);
  const config = await get2FAConfig(c.env.DB, prefix, userId);
  if (!config) {
    return c.json({ error: "2FA not configured" }, 400);
  }

  let verified = false;

  if (method === "totp" && config.totp_enabled && config.totp_secret) {
    verified = await verifyTOTPAsync(config.totp_secret, code, c.env, userId);
  } else if (method === "passkey") {
    return c.json({ error: "Use passkey authenticate endpoint" }, 400);
  } else {
    return c.json({ error: "Invalid 2FA method" }, 400);
  }

  if (!verified) {
    const failKey = `2fa_fail:${tempToken}`;
    const fails = Number((await c.env.KV.get(failKey)) || 0) + 1;
    if (fails >= 5) {
      await c.env.KV.delete(`2fa:${tempToken}`);
      await c.env.KV.delete(failKey);
    } else {
      await c.env.KV.put(failKey, String(fails), { expirationTtl: 300 });
    }
    return c.json({ error: "Invalid verification code" }, 401);
  }

  await c.env.KV.delete(`2fa:${tempToken}`);
  await c.env.KV.delete(`2fa_fail:${tempToken}`);

  const user = await findUserById(c.env.DB, prefix, userId);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (!user.is_active) return c.json({ error: "Account is disabled" }, 403);
  if (user.approval_status !== "approved") {
    return c.json({ error: "Account pending approval" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const sid = generateId();
  const accessJti = generateJti();
  const refreshJti = generateJti();

  const accessPayload: JWTPayload = {
    typ: "access",
    sub: userId,
    role: user.role,
    jti: accessJti,
    sid,
    iat: now,
    exp: now + 86400,
  };
  const refreshPayload: JWTPayload = {
    typ: "refresh",
    sub: userId,
    role: user.role,
    jti: refreshJti,
    sid,
    iat: now,
    exp: now + 604800,
  };

  const accessToken = await signJWT(accessPayload, c.env.JWT_SECRET);
  const refreshToken = await signJWT(refreshPayload, c.env.JWT_SECRET);

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
  setCookie(c, "refresh_token", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 604800,
  });

  return c.json({ success: true, user: publicUser(user) });
});

// Protected routes below - require auth
auth2faRoutes.use("/totp/*", authMiddleware);
auth2faRoutes.use("/passkey/register/*", authMiddleware);
auth2faRoutes.use("/passkey/disable", authMiddleware);

// TOTP setup (POST for frontend compatibility)
auth2faRoutes.post("/totp/setup", async (c) => {
  const userId = c.get("userId");
  const user = await findUserById(c.env.DB, getTablePrefix(c.env), userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  const { secret, uri } = await generateTOTPSecret(user.email);
  await c.env.KV.put(`totp_setup:${userId}`, secret, { expirationTtl: 600 });

  return c.json({ secret, uri });
});

// TOTP enable (verify setup code)
auth2faRoutes.post("/totp/enable", async (c) => {
  const userId = c.get("userId");
  const { code } = await c.req.json<{ code: string }>();
  if (!code) return c.json({ error: "Code required" }, 400);

  const prefix = getTablePrefix(c.env);
  const existingCfg = await get2FAConfig(c.env.DB, prefix, userId);
  if (existingCfg?.totp_enabled)
    return c.json({ error: "TOTP already enabled; disable it first" }, 400);

  const secret = await c.env.KV.get(`totp_setup:${userId}`);
  if (!secret) return c.json({ error: "No pending TOTP setup" }, 400);

  const valid = await verifyTOTPAsync(secret, code, c.env, userId);
  if (!valid) return c.json({ error: "Invalid code" }, 400);

  await upsert2FAConfig(c.env.DB, prefix, userId, {
    totp_secret: secret,
    totp_enabled: 1,
  });

  await c.env.KV.delete(`totp_setup:${userId}`);

  return c.json({ success: true });
});

// TOTP delete
auth2faRoutes.delete("/totp", authMiddleware, async (c) => {
  const pwErr = await requirePassword(c, await readPassword(c));
  if (pwErr) return pwErr;
  const userId = c.get("userId");

  await upsert2FAConfig(c.env.DB, getTablePrefix(c.env), userId, {
    totp_secret: null,
    totp_enabled: 0,
  });

  return c.json({ success: true });
});

// TOTP disable (POST alias)
auth2faRoutes.post("/totp/disable", async (c) => {
  const pwErr = await requirePassword(c, await readPassword(c));
  if (pwErr) return pwErr;
  const userId = c.get("userId");

  await upsert2FAConfig(c.env.DB, getTablePrefix(c.env), userId, {
    totp_secret: null,
    totp_enabled: 0,
  });

  return c.json({ success: true });
});

// Passkey disable (removes all passkeys)
auth2faRoutes.post("/passkey/disable", async (c) => {
  const pwErr = await requirePassword(c, await readPassword(c));
  if (pwErr) return pwErr;
  const userId = c.get("userId");

  await upsert2FAConfig(c.env.DB, getTablePrefix(c.env), userId, {
    passkey_credentials: null,
    passkey_enabled: 0,
  });

  return c.json({ success: true });
});

// Passkey register options
auth2faRoutes.post("/passkey/register/options", async (c) => {
  const userId = c.get("userId");
  const user = await findUserById(c.env.DB, getTablePrefix(c.env), userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  const { generateRegistrationOptions } = await import(
    "@simplewebauthn/server"
  );

  const config = await get2FAConfig(c.env.DB, getTablePrefix(c.env), userId);
  const existingCredentials = config?.passkey_credentials
    ? JSON.parse(config.passkey_credentials)
    : [];

  const options = await generateRegistrationOptions({
    rpName: "post",
    rpID: new URL(c.req.url).hostname,
    userName: user.email,
    userDisplayName: user.email,
    attestationType: "none",
    excludeCredentials: existingCredentials.map((cred: StoredCredential) => ({
      id: cred.id,
      type: "public-key",
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await c.env.KV.put(`passkey_challenge:${userId}`, options.challenge, {
    expirationTtl: 300,
  });

  return c.json(options);
});

// Passkey register verify
auth2faRoutes.post("/passkey/register/verify", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const expectedChallenge = await c.env.KV.get(`passkey_challenge:${userId}`);
  if (!expectedChallenge) return c.json({ error: "No pending challenge" }, 400);

  const { verifyRegistrationResponse } = await import("@simplewebauthn/server");

  const verification = await verifyRegistrationResponse({
    response: body,
    expectedChallenge,
    expectedOrigin: new URL(c.req.url).origin,
    expectedRPID: new URL(c.req.url).hostname,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "Verification failed" }, 400);
  }

  const { credential } = verification.registrationInfo;
  const prefix = getTablePrefix(c.env);
  const config = await get2FAConfig(c.env.DB, prefix, userId);
  const existingCredentials = config?.passkey_credentials
    ? JSON.parse(config.passkey_credentials)
    : [];

  existingCredentials.push({
    id: credential.id,
    publicKey: btoa(
      String.fromCharCode(...new Uint8Array(credential.publicKey)),
    ),
    counter: credential.counter,
    createdAt: new Date().toISOString(),
  });

  await upsert2FAConfig(c.env.DB, prefix, userId, {
    passkey_credentials: JSON.stringify(existingCredentials),
    passkey_enabled: 1,
  });

  await c.env.KV.delete(`passkey_challenge:${userId}`);

  return c.json({ success: true });
});

// Passkey authentication options (for 2FA login)
auth2faRoutes.post("/passkey/authenticate/options", async (c) => {
  const { tempToken } = await c.req.json<{ tempToken: string }>();
  if (!tempToken) return c.json({ error: "tempToken required" }, 400);

  const userId = await c.env.KV.get(`2fa:${tempToken}`);
  if (!userId) return c.json({ error: "Invalid session" }, 401);

  const config = await get2FAConfig(c.env.DB, getTablePrefix(c.env), userId);
  if (!config?.passkey_credentials)
    return c.json({ error: "No passkeys registered" }, 400);

  const credentials = JSON.parse(config.passkey_credentials);
  const { generateAuthenticationOptions } = await import(
    "@simplewebauthn/server"
  );

  const options = await generateAuthenticationOptions({
    rpID: new URL(c.req.url).hostname,
    allowCredentials: credentials.map((cred: StoredCredential) => ({
      id: cred.id,
      type: "public-key",
    })),
    userVerification: "preferred",
  });

  await c.env.KV.put(`passkey_auth_challenge:${tempToken}`, options.challenge, {
    expirationTtl: 300,
  });

  return c.json(options);
});

// Passkey authentication verify (for 2FA login)
auth2faRoutes.post("/passkey/authenticate/verify", async (c) => {
  const { tempToken, ...body } = await c.req.json();
  if (!tempToken) return c.json({ error: "tempToken required" }, 400);

  const userId = await c.env.KV.get(`2fa:${tempToken}`);
  if (!userId) return c.json({ error: "Invalid session" }, 401);

  const prefix = getTablePrefix(c.env);
  const config = await get2FAConfig(c.env.DB, prefix, userId);
  if (!config?.passkey_credentials)
    return c.json({ error: "No passkeys" }, 400);

  const credentials = JSON.parse(config.passkey_credentials);
  const expectedChallenge = await c.env.KV.get(
    `passkey_auth_challenge:${tempToken}`,
  );
  if (!expectedChallenge) return c.json({ error: "No pending challenge" }, 400);

  const credential = credentials.find(
    (cred: StoredCredential) => cred.id === body.id,
  );
  if (!credential) return c.json({ error: "Unknown credential" }, 400);

  const { verifyAuthenticationResponse } = await import(
    "@simplewebauthn/server"
  );

  const verification = await verifyAuthenticationResponse({
    response: body,
    expectedChallenge,
    expectedOrigin: new URL(c.req.url).origin,
    expectedRPID: new URL(c.req.url).hostname,
    credential: {
      id: credential.id,
      publicKey: Uint8Array.from(atob(credential.publicKey), (ch) =>
        ch.charCodeAt(0),
      ),
      counter: credential.counter,
    },
  });

  if (!verification.verified)
    return c.json({ error: "Verification failed" }, 401);

  // Update counter
  credential.counter = verification.authenticationInfo.newCounter;
  await upsert2FAConfig(c.env.DB, prefix, userId, {
    passkey_credentials: JSON.stringify(credentials),
  });

  await c.env.KV.delete(`2fa:${tempToken}`);
  await c.env.KV.delete(`passkey_auth_challenge:${tempToken}`);

  const user = await findUserById(c.env.DB, prefix, userId);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (!user.is_active) return c.json({ error: "Account is disabled" }, 403);
  if (user.approval_status !== "approved") {
    return c.json({ error: "Account pending approval" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const sid = generateId();
  const accessJti = generateJti();
  const refreshJti = generateJti();

  const accessPayload: JWTPayload = {
    typ: "access",
    sub: userId,
    role: user.role,
    jti: accessJti,
    sid,
    iat: now,
    exp: now + 86400,
  };
  const refreshPayload: JWTPayload = {
    typ: "refresh",
    sub: userId,
    role: user.role,
    jti: refreshJti,
    sid,
    iat: now,
    exp: now + 604800,
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

  return c.json({ success: true, user: publicUser(user) });
});

// Delete passkey
auth2faRoutes.delete("/passkey/:credentialId", authMiddleware, async (c) => {
  const pwErr = await requirePassword(c, await readPassword(c));
  if (pwErr) return pwErr;
  const userId = c.get("userId");
  const credentialId = c.req.param("credentialId");

  const prefix = getTablePrefix(c.env);
  const config = await get2FAConfig(c.env.DB, prefix, userId);
  if (!config?.passkey_credentials)
    return c.json({ error: "No passkeys" }, 400);

  const credentials = JSON.parse(config.passkey_credentials);
  const filtered = credentials.filter(
    (cred: StoredCredential) => cred.id !== credentialId,
  );

  if (filtered.length === 0) {
    await upsert2FAConfig(c.env.DB, prefix, userId, {
      passkey_credentials: null,
      passkey_enabled: 0,
    });
  } else {
    await upsert2FAConfig(c.env.DB, prefix, userId, {
      passkey_credentials: JSON.stringify(filtered),
    });
  }

  return c.json({ success: true });
});
