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
import type { Env } from "../src/types";
import { getTablePrefix } from "../src/types";
import { getSetting } from "../src/db/queries/users";
import {
  REGISTRATION_KEY,
  isRegistrationEnabled,
  setRegistrationEnabled,
} from "../src/lib/registration";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PW = "admin-test-pw-330";

/** 初始化 + 首账号（admin）+ 登录，返回管理员 Cookie 头。 */
async function adminEnv(overrides: Record<string, unknown> = {}) {
  const env = makeEnv(overrides);
  await doSetup(env, ADMIN_EMAIL, ADMIN_PW);
  const cookies = await loginAndGetCookies(env, ADMIN_EMAIL, ADMIN_PW);
  return { env, admin: cookieHeader(["access_token", cookies.access_token]) };
}

/** 再注册一个普通用户（已批准）+ 登录，返回其 Cookie 头。 */
async function normalUserHeader(env: Env, admin: Record<string, string>) {
  await registerAndApprove(env, admin, "user@example.com", "user-test-pw-330");
  const cookies = await loginAndGetCookies(
    env,
    "user@example.com",
    "user-test-pw-330",
  );
  return cookieHeader(["access_token", cookies.access_token]);
}

describe("注册开关（ONE-330 冻结契约）", () => {
  it("键缺失时默认开启：公开状态接口与管理员读取都报告 true", async () => {
    const { env, admin } = await adminEnv();

    // 键确实不存在（默认值不是靠写入实现的）
    expect(await getSetting(env.DB, getTablePrefix(env), REGISTRATION_KEY)).toBeNull();

    const pub = await request(env, "/api/auth/registration-state");
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual({ enabled: true });

    const adminGet = await request(env, "/api/admin/registration", {
      headers: admin,
    });
    expect(adminGet.status).toBe(200);
    expect(adminGet.body).toEqual({ enabled: true });
  });

  it("全新部署（表未建/未初始化）也按默认开启处理", async () => {
    const env = makeEnv();
    expect(await isRegistrationEnabled(env)).toBe(true);
    const { status, body } = await request(env, "/api/auth/registration-state");
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: true });
  });

  it("管理员读写开关：关闭后公开状态接口变 false，落 system_settings 值 \"0\"", async () => {
    const { env, admin } = await adminEnv();

    const off = await request(
      env,
      "/api/admin/registration",
      jsonInit("POST", { enabled: false }, admin),
    );
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ success: true, enabled: false });

    expect(
      (await request(env, "/api/admin/registration", { headers: admin })).body,
    ).toEqual({ enabled: false });
    expect(
      (await request(env, "/api/auth/registration-state")).body,
    ).toEqual({ enabled: false });
    // 与 setup_page_switch 同一存储（字符串 "0"）
    expect(await getSetting(env.DB, getTablePrefix(env), REGISTRATION_KEY)).toBe("0");

    const on = await request(
      env,
      "/api/admin/registration",
      jsonInit("POST", { enabled: true }, admin),
    );
    expect(on.body).toEqual({ success: true, enabled: true });
    expect(
      (await request(env, "/api/auth/registration-state")).body,
    ).toEqual({ enabled: true });
    expect(await getSetting(env.DB, getTablePrefix(env), REGISTRATION_KEY)).toBe("1");
  });

  it("管理接口鉴权：未登录 401 / 非管理员 403，且非管理员写入不生效", async () => {
    const { env, admin } = await adminEnv();
    const user = await normalUserHeader(env, admin);

    expect((await request(env, "/api/admin/registration")).status).toBe(401);
    expect(
      (
        await request(env, "/api/admin/registration", jsonInit("POST", { enabled: false }))
      ).status,
    ).toBe(401);

    expect(
      (await request(env, "/api/admin/registration", { headers: user })).status,
    ).toBe(403);
    expect(
      (
        await request(
          env,
          "/api/admin/registration",
          jsonInit("POST", { enabled: false }, user),
        )
      ).status,
    ).toBe(403);

    expect(
      (await request(env, "/api/auth/registration-state")).body,
    ).toEqual({ enabled: true });
  });

  it("公开状态接口无需登录（匿名可读）", async () => {
    const env = makeEnv();
    await setRegistrationEnabled(env, false);
    const { status, body } = await request(env, "/api/auth/registration-state");
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false });
  });

  it("请求体不是布尔值 → 400，开关不变", async () => {
    const { env, admin } = await adminEnv();

    for (const body of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }]) {
      const res = await request(
        env,
        "/api/admin/registration",
        jsonInit("POST", body, admin),
      );
      expect(res.status).toBe(400);
    }

    expect(
      (await request(env, "/api/admin/registration", { headers: admin })).body,
    ).toEqual({ enabled: true });
  });
});

describe("注册拦截（ONE-330：关闭后 POST /api/auth/register 403）", () => {
  it("关闭后注册 403 { error: \"Registration is disabled\" }，且不建账号", async () => {
    const { env, admin } = await adminEnv();

    await request(
      env,
      "/api/admin/registration",
      jsonInit("POST", { enabled: false }, admin),
    );

    const reg = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "newbie@example.com", password: "newbie-pw-330" }),
    );
    expect(reg.status).toBe(403);
    expect(reg.body).toEqual({ error: "Registration is disabled" });

    // 重新开启后同一邮箱可以正常注册
    await request(
      env,
      "/api/admin/registration",
      jsonInit("POST", { enabled: true }, admin),
    );
    const again = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "newbie@example.com", password: "newbie-pw-330" }),
    );
    expect(again.status).toBe(201);
    expect(again.body.pending).toBe(true);
  });

  it("注册关闭优先于 setup 判定（未初始化的部署也返回 Registration is disabled）", async () => {
    const env = makeEnv();
    await setRegistrationEnabled(env, false);

    const reg = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "a@example.com", password: "some-password-330" }),
    );
    expect(reg.status).toBe(403);
    expect(reg.body).toEqual({ error: "Registration is disabled" });

    // 对照：开关打开时回到既有 setup 口径
    await setRegistrationEnabled(env, true);
    const setupFirst = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "a@example.com", password: "some-password-330" }),
    );
    expect(setupFirst.status).toBe(403);
    expect(setupFirst.body.error).toContain("Setup required");
  });

  it("关闭注册不影响既有账号登录", async () => {
    const { env, admin } = await adminEnv();
    await setRegistrationEnabled(env, false);

    expect((await request(env, "/api/me", { headers: admin })).status).toBe(200);
    const cookies = await loginAndGetCookies(env, ADMIN_EMAIL, ADMIN_PW);
    expect(cookies.access_token).toBeDefined();
  });
});
