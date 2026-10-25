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

async function userEnv() {
  const env = makeEnv();
  await doSetup(env, "admin@example.com", "admin-pass-123");
  const adminCookies = await loginAndGetCookies(env, "admin@example.com", "admin-pass-123");
  const adminHeader = cookieHeader(["access_token", adminCookies.access_token]);
  await registerAndApprove(env, adminHeader, "alice@example.com", "alice-pass-123");
  const userCookies = await loginAndGetCookies(env, "alice@example.com", "alice-pass-123");
  return {
    env,
    admin: adminHeader,
    user: cookieHeader(["access_token", userCookies.access_token]),
  };
}

describe("设置路由 /api/settings/me（ONE-176 冻结契约）", () => {
  it("未登录 401", async () => {
    const { env } = await userEnv();
    expect((await request(env, "/api/settings/me")).status).toBe(401);
  });

  it("GET 返回昵称/时区/语言默认值与 2FA 状态", async () => {
    const { env, user } = await userEnv();
    const res = await request(env, "/api/settings/me", { headers: user });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: "alice@example.com",
      role: "user",
      display_name: "",
      timezone: "Asia/Shanghai",
      language: "zh",
      approval_status: "approved",
    });
    expect(res.body.twofa).toMatchObject({
      totp_enabled: false,
      passkey_enabled: false,
    });
  });

  it("PUT 更新昵称/时区/语言，GET 回读一致", async () => {
    const { env, user } = await userEnv();
    const put = await request(
      env,
      "/api/settings/me",
      jsonInit(
        "PUT",
        { display_name: "小满", timezone: "Asia/Tokyo", language: "en" },
        user,
      ),
    );
    expect(put.status).toBe(200);

    const get = await request(env, "/api/settings/me", { headers: user });
    expect(get.body).toMatchObject({
      display_name: "小满",
      timezone: "Asia/Tokyo",
      language: "en",
    });
  });

  it("非法时区/语言被拒", async () => {
    const { env, user } = await userEnv();
    expect(
      (await request(env, "/api/settings/me", jsonInit("PUT", { timezone: "Not/AZone" }, user)))
        .status,
    ).toBe(400);
    expect(
      (await request(env, "/api/settings/me", jsonInit("PUT", { language: "fr" }, user))).status,
    ).toBe(400);
  });

  it("昵称超长被拒", async () => {
    const { env, user } = await userEnv();
    expect(
      (await request(env, "/api/settings/me", jsonInit("PUT", { display_name: "x".repeat(51) }, user)))
        .status,
    ).toBe(400);
  });
});

describe("管理后台 PATCH /api/admin/users/:uid（ONE-176 冻结契约）", () => {
  it("PATCH 与 PUT 等价：改角色/禁用，并吊销会话", async () => {
    const { env, admin } = await userEnv();
    // 再建一个普通用户
    await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "bob@example.com", password: "bob-pass-123" }),
    );
    const users = (await request(env, "/api/admin/users", { headers: admin })).body as Array<{
      id: string;
      email: string;
      role: string;
    }>;
    const bob = users.find((u) => u.email === "bob@example.com");
    await request(env, `/api/admin/users/${bob!.id}/approve`, {
      method: "PUT",
      headers: admin,
    });
    const bobCookies = await loginAndGetCookies(env, "bob@example.com", "bob-pass-123");
    const bobHeader = cookieHeader(["access_token", bobCookies.access_token]);

    // PATCH 提升为 admin
    const patch = await request(
      env,
      `/api/admin/users/${bob!.id}`,
      jsonInit("PATCH", { role: "admin" }, admin),
    );
    expect(patch.status).toBe(200);

    const reread = (await request(env, "/api/admin/users", { headers: admin })).body as Array<{
      id: string;
      role: string;
    }>;
    expect(reread.find((u) => u.id === bob!.id)!.role).toBe("admin");

    // 角色变更吊销旧会话
    expect((await request(env, "/api/me", { headers: bobHeader })).status).toBe(401);
  });

  it("PATCH 禁用自己/降级自己被拒", async () => {
    const { env, admin } = await userEnv();
    const users = (await request(env, "/api/admin/users", { headers: admin })).body as Array<{
      id: string;
      role: string;
    }>;
    const me = users.find((u) => u.role === "admin");
    expect(
      (await request(env, `/api/admin/users/${me!.id}`, jsonInit("PATCH", { is_active: false }, admin)))
        .status,
    ).toBe(400);
    expect(
      (await request(env, `/api/admin/users/${me!.id}`, jsonInit("PATCH", { role: "user" }, admin)))
        .status,
    ).toBe(400);
  });
});
