import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { setupRoutes } from "../src/routes/setup";
import { getTablePrefix, type HonoEnv } from "../src/types";
import { countUsers, listUsers } from "../src/db/queries/users";
import {
  cookieHeader,
  cookieValue,
  doSetup,
  jsonInit,
  loginAndGetCookies,
  makeEnv,
  registerAndApprove,
  request,
  setupSecretHeader,
  ipHeader,
} from "./helpers";

describe("setup（首次部署创建管理员，创建后关闭）", () => {
  it("state reports enabled on a fresh deployment", async () => {
    const env = makeEnv();
    const { status, body } = await request(env, "/api/setup/state");
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: true });
  });

  it("rejects POST without / with wrong X-Setup-Secret", async () => {
    const env = makeEnv();
    const noSecret = await request(
      env,
      "/api/setup",
      jsonInit("POST", { email: "admin@example.com", password: "admin-password-123" }),
    );
    expect(noSecret.status).toBe(403);

    const wrongSecret = await request(
      env,
      "/api/setup",
      jsonInit("POST", { email: "admin@example.com", password: "admin-password-123" }, {
        "X-Setup-Secret": "wrong",
      }),
    );
    expect(wrongSecret.status).toBe(403);
  });

  it("GET with secret in path is deprecated (405)", async () => {
    const env = makeEnv();
    const { status } = await request(env, "/api/setup/whatever");
    expect(status).toBe(405);
  });

  it("creates the first account as admin+approved, then closes setup", async () => {
    const env = makeEnv();
    const { status, body } = await request(
      env,
      "/api/setup",
      jsonInit(
        "POST",
        { email: "Admin@Example.com", password: "admin-password-123" },
        setupSecretHeader(),
      ),
    );
    expect(status).toBe(201);
    expect(body.user).toMatchObject({
      email: "admin@example.com",
      role: "admin",
      approval_status: "approved",
    });

    // state 关闭 + 再次 setup 被拒
    expect((await request(env, "/api/setup/state")).body).toEqual({
      enabled: false,
    });
    const again = await request(
      env,
      "/api/setup",
      jsonInit(
        "POST",
        { email: "other@example.com", password: "admin-password-123" },
        setupSecretHeader(),
      ),
    );
    expect(again.status).toBe(403);
    expect(again.body).toEqual({ error: "Setup is closed" });
  });

  it("register cannot bootstrap the first account before setup runs", async () => {
    const env = makeEnv();
    const { status, body } = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "a@example.com", password: "user-password-123" }),
    );
    expect(status).toBe(403);
    expect(body.error).toContain("Setup required");
  });
});

describe("注册 → 待批准 → 管理员批准 → 登录（验收口径）", () => {
  it("pending user cannot login; after approval login works", async () => {
    const env = makeEnv();
    await doSetup(env);

    // 注册成功，返回 pending
    const reg = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "user@example.com", password: "user-password-123" }),
    );
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ success: true, pending: true });

    // 待批准：登录被拒
    const pendingLogin = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "user@example.com", password: "user-password-123" }),
    );
    expect(pendingLogin.status).toBe(403);
    expect(pendingLogin.body).toMatchObject({ pending: true });

    // 管理员登录并批准
    const adminCookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    expect(adminCookies.access_token).toBeDefined();

    const uid = await registerAndApprove(env, {
      ...cookieHeader(["access_token", adminCookies.access_token]),
    });
    expect(uid).toBeTruthy();

    // 批准后可登录
    const login = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "user@example.com", password: "user-password-123" }),
    );
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      success: true,
      user: { email: "user@example.com", role: "user" },
    });

    // cookie 属性：HttpOnly / SameSite=Strict / Secure / Path=/（顺序不固定，逐项断言）
    const setCookie = login.res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/access_token=[^;]+/);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it("wrong password is rejected with generic 401", async () => {
    const env = makeEnv();
    await doSetup(env);
    const login = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "admin@example.com", password: "wrong-password" }),
    );
    expect(login.status).toBe(401);
    expect(login.body).toEqual({ error: "Invalid credentials" });
  });
});

describe("会话（HttpOnly Cookie + refresh + logout）", () => {
  it("protects /api/me without cookie, serves with cookie, logout revokes", async () => {
    const env = makeEnv();
    await doSetup(env);

    const anon = await request(env, "/api/me");
    expect(anon.status).toBe(401);

    const cookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const headers = cookieHeader(
      ["access_token", cookies.access_token],
      ["refresh_token", cookies.refresh_token],
    );

    const me = await request(env, "/api/me", { headers });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: "admin@example.com", role: "admin" });

    // logout 后会话失效
    await request(env, "/api/auth/logout", { method: "POST", headers });
    const meAfter = await request(env, "/api/me", { headers });
    expect(meAfter.status).toBe(401);
  });

  it("refresh issues a new working access token", async () => {
    const env = makeEnv();
    await doSetup(env);
    const cookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");

    const refresh = await request(
      env,
      "/api/auth/refresh",
      { method: "POST", headers: cookieHeader(["refresh_token", cookies.refresh_token]) },
    );
    expect(refresh.status).toBe(200);

    const newAccess = cookieValue(refresh.res, "access_token");
    expect(newAccess).toBeDefined();
    const me = await request(
      env,
      "/api/me",
      { headers: cookieHeader(["access_token", newAccess]) },
    );
    expect(me.status).toBe(200);
  });

  it("refresh without refresh_token cookie is 401", async () => {
    const env = makeEnv();
    await doSetup(env);
    const { status } = await request(env, "/api/auth/refresh", { method: "POST" });
    expect(status).toBe(401);
  });
});

describe("登录限流（eNotify 同款参数）", () => {
  it("returns 429 after 10 failed logins in the window", async () => {
    const env = makeEnv();
    await doSetup(env);

    let last = 0;
    for (let i = 0; i < 10; i++) {
      const res = await request(
        env,
        "/api/auth/login",
        jsonInit("POST", { email: "admin@example.com", password: "wrong" }, ipHeader("9.9.9.9")),
      );
      last = res.status;
    }
    expect(last).toBe(401);

    const limited = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "admin@example.com", password: "wrong" }, ipHeader("9.9.9.9")),
    );
    expect(limited.status).toBe(429);
  });
});

describe("me 路由（昵称/时区/语言/改密码）", () => {
  it("updates display_name / timezone / language", async () => {
    const env = makeEnv();
    await doSetup(env);
    const cookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const headers = cookieHeader(["access_token", cookies.access_token]);

    const upd = await request(
      env,
      "/api/me",
      jsonInit("PUT", { display_name: "小明", timezone: "Asia/Shanghai", language: "zh" }, headers),
    );
    expect(upd.status).toBe(200);

    const me = await request(env, "/api/me", { headers });
    expect(me.body).toMatchObject({
      display_name: "小明",
      timezone: "Asia/Shanghai",
      language: "zh",
    });
  });

  it("rejects invalid timezone and language", async () => {
    const env = makeEnv();
    await doSetup(env);
    const cookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const headers = cookieHeader(["access_token", cookies.access_token]);

    const badTz = await request(
      env,
      "/api/me",
      jsonInit("PUT", { timezone: "Not/A_Zone" }, headers),
    );
    expect(badTz.status).toBe(400);

    const badLang = await request(
      env,
      "/api/me",
      jsonInit("PUT", { language: "fr" }, headers),
    );
    expect(badLang.status).toBe(400);
  });

  it("password change requires current password and revokes old tokens", async () => {
    const env = makeEnv();
    await doSetup(env);
    const cookies = await loginAndGetCookies(env, "admin@example.com", "admin-password-123");
    const headers = cookieHeader(
      ["access_token", cookies.access_token],
      ["refresh_token", cookies.refresh_token],
    );

    const wrong = await request(
      env,
      "/api/me/password",
      jsonInit("PUT", { currentPassword: "wrong", newPassword: "new-password-123" }, headers),
    );
    expect(wrong.status).toBe(401);

    const ok = await request(
      env,
      "/api/me/password",
      jsonInit("PUT", { currentPassword: "admin-password-123", newPassword: "new-password-123" }, headers),
    );
    expect(ok.status).toBe(200);

    // 旧密码失效；新密码可登录
    const oldLogin = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "admin@example.com", password: "admin-password-123" }),
    );
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "admin@example.com", password: "new-password-123" }),
    );
    expect(newLogin.status).toBe(200);
  });
});

describe("敏感密钥占位符防绕过（ONE-192 Blocking）", () => {
  it.each([
    ["placeholder 值", "SETUP_SECRET_PLACEHOLDER"],
    ["过短", "short"],
  ])(
    "SETUP_SECRET %s → /api/* 一律 500，占位符回传无法建号提权",
    async (_label, bad) => {
      const env = makeEnv({ SETUP_SECRET: bad });

      // Tony 的复现路径：X-Setup-Secret 回传占位符本身
      const setup = await request(
        env,
        "/api/setup",
        jsonInit(
          "POST",
          { email: "attacker@example.com", password: "admin-password-123" },
          { "X-Setup-Secret": "SETUP_SECRET_PLACEHOLDER" },
        ),
      );
      expect(setup.status).toBe(500);
      expect(setup.body).toEqual({ error: "Server misconfigured" });

      // 其余 API 同样被 fail-safe 拦截
      expect((await request(env, "/api/health")).status).toBe(500);
      expect((await request(env, "/api/setup/state")).status).toBe(500);
      expect(
        (
          await request(
            env,
            "/api/auth/register",
            jsonInit("POST", { email: "x@example.com", password: "user-password-123" }),
          )
        ).status,
      ).toBe(500);

      // 建号确实没有发生
      expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
    },
  );

  it("SETUP_SECRET 缺失 → /api/* 一律 500，无法建号", async () => {
    const env = makeEnv({ SETUP_SECRET: undefined });
    const setup = await request(
      env,
      "/api/setup",
      jsonInit(
        "POST",
        { email: "attacker@example.com", password: "admin-password-123" },
        setupSecretHeader(),
      ),
    );
    expect(setup.status).toBe(500);
    expect((await request(env, "/api/health")).status).toBe(500);
    expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
  });

  it.each([
    ["placeholder 值", "JWT_SECRET_PLACEHOLDER"],
    ["过短", "short"],
    ["缺失", undefined],
  ])("JWT_SECRET %s → /api/* 一律 500", async (_label, bad) => {
    const env = makeEnv({ JWT_SECRET: bad });
    expect((await request(env, "/api/health")).status).toBe(500);
    const setup = await request(
      env,
      "/api/setup",
      jsonInit(
        "POST",
        { email: "attacker@example.com", password: "admin-password-123" },
        setupSecretHeader(),
      ),
    );
    expect(setup.status).toBe(500);
    expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
  });

  it("路由层防守校验独立生效（不经 fail-safe 中间件，双保险）", async () => {
    for (const bad of [
      "SETUP_SECRET_PLACEHOLDER",
      "",
      undefined,
    ] as (string | undefined)[]) {
      const bare = new Hono<HonoEnv>();
      bare.route("/api/setup", setupRoutes);
      const env = makeEnv({ SETUP_SECRET: bad });
      const res = await bare.request(
        "/api/setup",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Setup-Secret": "SETUP_SECRET_PLACEHOLDER",
          },
          body: JSON.stringify({
            email: "attacker@example.com",
            password: "admin-password-123",
          }),
        },
        env,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Server misconfigured" });
      expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
    }
  });
});

describe("并发 setup 竞态（ONE-192 Should-fix）", () => {
  it("只有一个请求能建出管理员，后到请求 403 且不留垃圾行", async () => {
    const env = makeEnv();
    const [a, b] = await Promise.all([
      request(
        env,
        "/api/setup",
        jsonInit(
          "POST",
          { email: "first@example.com", password: "admin-password-123" },
          setupSecretHeader(),
        ),
      ),
      request(
        env,
        "/api/setup",
        jsonInit(
          "POST",
          { email: "second@example.com", password: "admin-password-123" },
          setupSecretHeader(),
        ),
      ),
    ]);

    // 一个 201（胜者建出 admin），一个 403（后到者不误报成功）
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    const loser = a.status === 403 ? a : b;
    expect(loser.body).toEqual({ error: "Setup is closed" });

    // 库里只有胜者一个 admin；竞态插入的 user 行已被清理
    const users = await listUsers(env.DB, getTablePrefix(env));
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("admin");
    expect(users[0].approval_status).toBe("approved");

    // setup 已关闭
    expect((await request(env, "/api/setup/state")).body).toEqual({
      enabled: false,
    });
  });
});
