import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cookieHeader,
  doSetup,
  jsonInit,
  loginAndGetCookies,
  makeEnv,
  request,
} from "./helpers";

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("../src/services/email", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/email")>();
  return { ...mod, sendEmail: sendEmailMock };
});

async function adminEnv() {
  const env = makeEnv();
  await doSetup(env, "admin@example.com", "adminpass123");
  const cookies = await loginAndGetCookies(env, "admin@example.com", "adminpass123");
  return {
    env,
    admin: cookieHeader(["access_token", cookies.access_token]),
  };
}

beforeEach(() => {
  sendEmailMock.mockReset();
});

describe("管理后台 SMTP 配置与测试邮件（ONE-176）", () => {
  it("未登录/非管理员不可访问", async () => {
    const { env, admin } = await adminEnv();
    expect((await request(env, "/api/admin/settings/smtp")).status).toBe(401);

    // 普通用户
    await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "alice@example.com", password: "alicepass123" }),
    );
    const users = (
      await request(env, "/api/admin/users", { headers: admin })
    ).body as { id: string; email: string }[];
    const target = users.find((u) => u.email === "alice@example.com");
    await request(env, `/api/admin/users/${target!.id}/approve`, {
      method: "PUT",
      headers: admin,
    });
    const userCookies = await loginAndGetCookies(env, "alice@example.com", "alicepass123");
    const userHeader = cookieHeader(["access_token", userCookies.access_token]);
    expect((await request(env, "/api/admin/settings/smtp", { headers: userHeader })).status).toBe(403);
  });

  it("PUT 保存配置，GET 密码脱敏返回（password 空 + password_set 标记）", async () => {
    const { env, admin } = await adminEnv();
    const put = await request(
      env,
      "/api/admin/settings/smtp",
      jsonInit(
        "PUT",
        {
          host: "smtp.example.com",
          port: 465,
          username: "noreply@example.com",
          password: "super-secret-password",
          from: "noreply@example.com",
          from_name: "post",
        },
        admin,
      ),
    );
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      host: "smtp.example.com",
      port: 465,
      username: "noreply@example.com",
      password: "",
      password_set: true,
    });

    const get = await request(env, "/api/admin/settings/smtp", { headers: admin });
    expect(get.status).toBe(200);
    // 原文绝不下发
    expect(JSON.stringify(get.body)).not.toContain("super-secret-password");
    expect(get.body.password).toBe("");
    expect(get.body.password_set).toBe(true);

    // 落库原文用于真实发送
    const raw = await env.DB.prepare(`SELECT value FROM system_settings WHERE key = ?`)
      .bind("smtp_config")
      .first<{ value: string }>();
    expect(JSON.parse(raw!.value).password).toBe("super-secret-password");
  });

  it("PUT 密码留空表示不改", async () => {
    const { env, admin } = await adminEnv();
    await request(
      env,
      "/api/admin/settings/smtp",
      jsonInit(
        "PUT",
        { host: "smtp.example.com", port: 465, username: "u", password: "original-pass", from: "u@example.com", from_name: "x" },
        admin,
      ),
    );
    // 只改 host，password 留空
    const put2 = await request(
      env,
      "/api/admin/settings/smtp",
      jsonInit(
        "PUT",
        { host: "smtp2.example.com", port: 465, username: "u", password: "", from: "u@example.com", from_name: "x" },
        admin,
      ),
    );
    expect(put2.body.password_set).toBe(true);
    const raw = await env.DB.prepare(`SELECT value FROM system_settings WHERE key = ?`)
      .bind("smtp_config")
      .first<{ value: string }>();
    expect(JSON.parse(raw!.value).password).toBe("original-pass");
  });

  it("测试邮件即时报错原文", async () => {
    const { env, admin } = await adminEnv();
    sendEmailMock.mockResolvedValue({ success: false, error: "SMTP error: auth failed 535 5.7.8" });

    const res = await request(
      env,
      "/api/admin/settings/smtp/test",
      jsonInit("POST", { email: "target@example.com" }, admin),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, error: "SMTP error: auth failed 535 5.7.8" });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][1].to).toBe("target@example.com");
  });

  it("测试邮件成功回显 success", async () => {
    const { env, admin } = await adminEnv();
    sendEmailMock.mockResolvedValue({ success: true });

    const res = await request(
      env,
      "/api/admin/settings/smtp/test",
      jsonInit("POST", { email: "target@example.com" }, admin),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
