import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  doSetup,
  jsonInit,
  loginAndGetCookies,
  makeEnv,
  registerAndApprove,
  request,
} from "./helpers";

// 测试内自实现的最小 TOTP 生成器（仅用于验证服务端校验逻辑）
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/[=\s]/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

async function totpCode(secret: string, offset = 0): Promise<string> {
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(counter));
  const hash = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const o = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[o] & 0x7f) << 24) |
    ((hash[o + 1] & 0xff) << 16) |
    ((hash[o + 2] & 0xff) << 8) |
    (hash[o + 3] & 0xff);
  return (binary % 1000000).toString().padStart(6, "0");
}

describe("TOTP 2FA（eNotify 移植）", () => {
  it("setup → enable → login requires 2FA → verify with code → session issued", async () => {
    const env = makeEnv();
    await doSetup(env);
    const adminCookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const adminHeader = cookieHeader(["access_token", adminCookies.access_token]);

    const uid = await registerAndApprove(env, adminHeader);

    // 用户登录拿 cookie，开 TOTP setup
    const userCookies = await loginAndGetCookies(env, "user@example.com", "user-password-123");
    const userHeader = cookieHeader(["access_token", userCookies.access_token]);

    const setup = await request(
      env,
      "/api/auth/2fa/totp/setup",
      jsonInit("POST", {}, userHeader),
    );
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.uri).toContain("otpauth://totp/post:");

    // 错误验证码 enable 失败
    const badEnable = await request(
      env,
      "/api/auth/2fa/totp/enable",
      jsonInit("POST", { code: "000000" }, userHeader),
    );
    expect(badEnable.status).toBe(400);

    // 正确验证码 enable 成功
    const enable = await request(
      env,
      "/api/auth/2fa/totp/enable",
      jsonInit("POST", { code: await totpCode(setup.body.secret) }, userHeader),
    );
    expect(enable.status).toBe(200);

    // /api/me 报告 totp_enabled
    const me = await request(env, "/api/me", { headers: userHeader });
    expect(me.body.twofa).toMatchObject({ totp_enabled: true });

    // 再次登录：要求 2FA，返回 tempToken
    const login = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "user@example.com", password: "user-password-123" }),
    );
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      requires2fa: true,
      availableMethods: ["totp"],
    });
    const { tempToken } = login.body;

    // 错误 code 被拒
    const badVerify = await request(
      env,
      "/api/auth/2fa/verify",
      jsonInit("POST", { tempToken, method: "totp", code: "123456" }),
    );
    expect(badVerify.status).toBe(401);

    // 正确 code 通过（用下一个时间窗的 code，避开 enable 已用过的防重放记录）
    const verify = await request(
      env,
      "/api/auth/2fa/verify",
      jsonInit("POST", { tempToken, method: "totp", code: await totpCode(setup.body.secret, 1) }),
    );
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({
      success: true,
      user: { id: uid, email: "user@example.com" },
    });

    // tempToken 一次性：重放被拒
    const replay = await request(
      env,
      "/api/auth/2fa/verify",
      jsonInit("POST", { tempToken, method: "totp", code: await totpCode(setup.body.secret, 1) }),
    );
    expect(replay.status).toBe(401);

    // verify 签发的 cookie 可用
    const accessCookie = verify.res.headers
      .getSetCookie()
      .find((l) => l.startsWith("access_token="));
    expect(accessCookie).toBeDefined();
    const token = accessCookie!.split(";")[0].split("=")[1];
    const meAfter = await request(
      env,
      "/api/me",
      { headers: cookieHeader(["access_token", token]) },
    );
    expect(meAfter.status).toBe(200);
  });

  it("same TOTP code cannot be replayed for login verify (anti-replay)", async () => {
    const env = makeEnv();
    await doSetup(env);
    const adminCookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const adminHeader = cookieHeader(["access_token", adminCookies.access_token]);
    await registerAndApprove(env, adminHeader);

    const userCookies = await loginAndGetCookies(env, "user@example.com", "user-password-123");
    const userHeader = cookieHeader(["access_token", userCookies.access_token]);

    const setup = await request(
      env,
      "/api/auth/2fa/totp/setup",
      jsonInit("POST", {}, userHeader),
    );
    const code = await totpCode(setup.body.secret);
    await request(env, "/api/auth/2fa/totp/enable", jsonInit("POST", { code }, userHeader));

    // login → tempToken；enable 时已用过的同一个 code 再用来 verify 应被防重放拒绝
    const login = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "user@example.com", password: "user-password-123" }),
    );
    const verify = await request(
      env,
      "/api/auth/2fa/verify",
      jsonInit("POST", {
        tempToken: login.body.tempToken,
        method: "totp",
        code,
      }),
    );
    expect(verify.status).toBe(401);
  });

  it("disable TOTP requires account password", async () => {
    const env = makeEnv();
    await doSetup(env);
    const adminCookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const adminHeader = cookieHeader(["access_token", adminCookies.access_token]);
    await registerAndApprove(env, adminHeader);

    const userCookies = await loginAndGetCookies(env, "user@example.com", "user-password-123");
    const userHeader = cookieHeader(["access_token", userCookies.access_token]);

    const setup = await request(
      env,
      "/api/auth/2fa/totp/setup",
      jsonInit("POST", {}, userHeader),
    );
    await request(
      env,
      "/api/auth/2fa/totp/enable",
      jsonInit("POST", { code: await totpCode(setup.body.secret) }, userHeader),
    );

    const noPw = await request(
      env,
      "/api/auth/2fa/totp/disable",
      jsonInit("POST", {}, userHeader),
    );
    expect(noPw.status).toBe(400);

    const wrongPw = await request(
      env,
      "/api/auth/2fa/totp/disable",
      jsonInit("POST", { password: "wrong-password" }, userHeader),
    );
    expect(wrongPw.status).toBe(403);

    const ok = await request(
      env,
      "/api/auth/2fa/totp/disable",
      jsonInit("POST", { password: "user-password-123" }, userHeader),
    );
    expect(ok.status).toBe(200);

    // 关闭后登录不再要求 2FA
    const login = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "user@example.com", password: "user-password-123" }),
    );
    expect(login.body).toMatchObject({ success: true });
  });
});
