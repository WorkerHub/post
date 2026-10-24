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

async function adminEnv() {
  const env = makeEnv();
  await doSetup(env);
  const cookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
  return { env, admin: cookieHeader(["access_token", cookies.access_token]) };
}

describe("admin 路由（批准/禁用/角色，冻结契约供后端④复用）", () => {
  it("requires admin role", async () => {
    const env = makeEnv();
    await doSetup(env);

    // 未登录
    expect((await request(env, "/api/admin/users")).status).toBe(401);

    // 普通用户
    const adminCookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const adminHeader = cookieHeader(["access_token", adminCookies.access_token]);
    await registerAndApprove(env, adminHeader);
    const userCookies = await loginAndGetCookies(env, "user@example.com", "user-password-123");

    const forbidden = await request(
      env,
      "/api/admin/users",
      { headers: cookieHeader(["access_token", userCookies.access_token]) },
    );
    expect(forbidden.status).toBe(403);
  });

  it("lists users with approval_status", async () => {
    const { env, admin } = await adminEnv();
    const { status, body } = await request(env, "/api/admin/users", { headers: admin });
    expect(status).toBe(200);
    expect(body.some((u: any) => u.role === "admin" && u.approval_status === "approved")).toBe(
      true,
    );
  });

  it("approve is idempotent and unknown user 404s", async () => {
    const { env, admin } = await adminEnv();
    await registerAndApprove(env, admin);

    const users = (await request(env, "/api/admin/users", { headers: admin })).body as any[];
    const target = users.find((u) => u.email === "user@example.com");

    const again = await request(env, `/api/admin/users/${target.id}/approve`, {
      method: "PUT",
      headers: admin,
    });
    expect(again.status).toBe(200);

    const missing = await request(env, "/api/admin/users/no-such-id/approve", {
      method: "PUT",
      headers: admin,
    });
    expect(missing.status).toBe(404);
  });

  it("disabling a user kills their active session", async () => {
    const { env, admin } = await adminEnv();
    const uid = await registerAndApprove(env, admin);
    const userCookies = await loginAndGetCookies(env, "user@example.com", "user-password-123");
    const userHeader = cookieHeader(["access_token", userCookies.access_token]);
    expect((await request(env, "/api/me", { headers: userHeader })).status).toBe(200);

    const disable = await request(
      env,
      `/api/admin/users/${uid}`,
      jsonInit("PUT", { is_active: false }, admin),
    );
    expect(disable.status).toBe(200);

    // 会话已被吊销
    expect((await request(env, "/api/me", { headers: userHeader })).status).toBe(401);

    // 禁用账号登录被拒
    const login = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "user@example.com", password: "user-password-123" }),
    );
    expect(login.status).toBe(403);
    expect(login.body).toEqual({ error: "Account is disabled" });
  });

  it("self-protection: cannot disable/demote/delete yourself", async () => {
    const { env, admin } = await adminEnv();
    const users = (await request(env, "/api/admin/users", { headers: admin })).body as any[];
    const me = users.find((u) => u.role === "admin");

    expect(
      (await request(env, `/api/admin/users/${me.id}`, jsonInit("PUT", { is_active: false }, admin)))
        .status,
    ).toBe(400);
    expect(
      (await request(env, `/api/admin/users/${me.id}`, jsonInit("PUT", { role: "user" }, admin)))
        .status,
    ).toBe(400);
    expect(
      (await request(env, `/api/admin/users/${me.id}`, { method: "DELETE", headers: admin }))
        .status,
    ).toBe(400);
  });

  it("role change revokes sessions", async () => {
    const { env, admin } = await adminEnv();
    const uid = await registerAndApprove(env, admin);
    const userCookies = await loginAndGetCookies(env, "user@example.com", "user-password-123");
    const userHeader = cookieHeader(["access_token", userCookies.access_token]);
    expect((await request(env, "/api/me", { headers: userHeader })).status).toBe(200);

    await request(env, `/api/admin/users/${uid}`, jsonInit("PUT", { role: "admin" }, admin));
    expect((await request(env, "/api/me", { headers: userHeader })).status).toBe(401);
  });

  it("admin can create an approved user directly", async () => {
    const { env, admin } = await adminEnv();
    const created = await request(
      env,
      "/api/admin/users",
      jsonInit("POST", { email: "direct@example.com", password: "{{SECRET_5qxrreka}}" }, admin),
    );
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({
      email: "direct@example.com",
      role: "user",
      approval_status: "approved",
    });

    const login = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "direct@example.com", password: "{{SECRET_5qxrreka}}" }),
    );
    expect(login.status).toBe(200);
  });
});
