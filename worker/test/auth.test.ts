import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { setupRoutes } from "../src/routes/setup";
import { getTablePrefix, migrationsTable, type HonoEnv } from "../src/types";
import { getMigrations } from "../src/db/migrations";
import { countUsers, listUsers } from "../src/db/queries/users";
import {
  cookieHeader,
  cookieValue,
  doSetup,
  jsonInit,
  loginAndGetCookies,
  makeEnv,
  makeMigratedDb,
  registerAndApprove,
  request,
  setupInit,
  SqliteD1,
  TEST_SETUP_SECRET,
  ipHeader,
} from "./helpers";

describe("setup（ONE-313：只填 SETUP_SECRET 完成初始化，不建任何账号）", () => {
  it("state reports enabled on a fresh deployment", async () => {
    const env = makeEnv();
    const { status, body } = await request(env, "/api/setup/state");
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: true });
  });

  it("rejects POST without setup_secret / with wrong secret / with legacy header", async () => {
    const env = makeEnv();

    // 请求体缺失 setup_secret
    const noSecret = await request(env, "/api/setup", jsonInit("POST", {}));
    expect(noSecret.status).toBe(403);
    expect(noSecret.body).toEqual({ error: "Invalid setup secret" });

    // 只带旧版 X-Setup-Secret 头、请求体没有密钥：不再被接受
    const legacyHeader = await request(
      env,
      "/api/setup",
      jsonInit("POST", {}, { "X-Setup-Secret": TEST_SETUP_SECRET }),
    );
    expect(legacyHeader.status).toBe(403);
    expect(legacyHeader.body).toEqual({ error: "Invalid setup secret" });

    // 密钥不符
    const wrongSecret = await request(env, "/api/setup", setupInit("wrong"));
    expect(wrongSecret.status).toBe(403);
    expect(wrongSecret.body).toEqual({ error: "Invalid setup secret" });

    // 失败后 setup 仍开放，且没有建出任何账号
    expect((await request(env, "/api/setup/state")).body).toEqual({
      enabled: true,
    });
    expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
  });

  it("GET with secret in path is deprecated (405)", async () => {
    const env = makeEnv();
    const { status } = await request(env, "/api/setup/whatever");
    expect(status).toBe(405);
  });

  it("correct secret closes setup without creating any account", async () => {
    const env = makeEnv();
    const { status, body } = await request(env, "/api/setup", setupInit());
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, table_prefix: "post_" });
    // 测试替身库已初始化过（账本已记全部迁移）→ 本次全部 skipped
    expect(body.migrations).toEqual(
      getMigrations(getTablePrefix(env)).map((m) => ({
        name: m.name,
        status: "skipped",
      })),
    );

    // setup 关闭，但账号数仍为 0（初始化不建号）
    expect((await request(env, "/api/setup/state")).body).toEqual({
      enabled: false,
    });
    expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);

    // 再次提交被拒
    const again = await request(env, "/api/setup", setupInit());
    expect(again.status).toBe(403);
    expect(again.body).toEqual({ error: "Setup is closed" });
  });

  it("全新部署（空库）：POST /api/setup 跑迁移账本建出 schema（ONE-347）", async () => {
    // 空库：任何表都没有，模拟首次部署
    const env = makeEnv({ DB: new SqliteD1("") as unknown as D1Database });

    const { status, body } = await request(env, "/api/setup", setupInit());
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.table_prefix).toBe("post_");
    expect(body.applied).toBe(getMigrations("post_").length);
    expect(body.migrations).toEqual(
      getMigrations("post_").map((m) => ({ name: m.name, status: "applied" })),
    );

    // 业务表与账本表都建出来了
    const tables = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "post_users",
        "post_letters",
        "post_system_settings",
        "post_waker_executions",
        migrationsTable("post_"),
      ]),
    );

    // 账本按序记下全部迁移
    const ledger = (
      await env.DB.prepare(`SELECT name FROM ${migrationsTable("post_")}`).all<{
        name: string;
      }>()
    ).results.map((r) => r.name);
    expect(ledger).toEqual(getMigrations("post_").map((m) => m.name));

    // 初始化完成：setup 关闭，且仍未建任何账号
    expect((await request(env, "/api/setup/state")).body).toEqual({
      enabled: false,
    });
    expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
  });

  it("前缀冲突：库已按其他前缀初始化 → 409，不建新前缀的表（ONE-347）", async () => {
    // 库在无前缀下初始化过，但当前环境解析成默认 post_
    const initialized = makeMigratedDb("");
    const env = makeEnv({ DB: initialized as unknown as D1Database });

    const { status, body } = await request(env, "/api/setup", setupInit());
    expect(status).toBe(409);
    expect(body.error).toContain("无前缀 schema");

    // 没有按新前缀另建一套表
    const tables = (
      await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables).not.toContain("post_users");
    expect(tables).not.toContain("_post_schema_migrations");
    // setup 未被关闭
    expect((await request(env, "/api/setup/state")).body).toEqual({
      enabled: true,
    });
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
    expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
  });

  it("the first register after setup becomes admin+approved and can login", async () => {
    const env = makeEnv();
    await request(env, "/api/setup", setupInit());

    const reg = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "Owner@Example.com", password: "admin-password-123" }),
    );
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({
      success: true,
      role: "admin",
      approval_status: "approved",
      pending: false,
    });

    const users = await listUsers(env.DB, getTablePrefix(env));
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("admin");
    expect(users[0].approval_status).toBe("approved");

    // 既有管理员登录流程：直接可登录，无需等批准
    const cookies = await loginAndGetCookies(env, "owner@example.com", "admin-password-123");
    expect(cookies.access_token).toBeDefined();
    const me = await request(env, "/api/me", {
      headers: cookieHeader(["access_token", cookies.access_token]),
    });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: "owner@example.com", role: "admin" });

    // setup 已关闭，state 不再开放
    expect((await request(env, "/api/setup/state")).body).toEqual({
      enabled: false,
    });
  });

  it("later registrations stay user+pending until an admin approves", async () => {
    const env = makeEnv();
    await doSetup(env);

    const second = await request(
      env,
      "/api/auth/register",
      jsonInit("POST", { email: "friend@example.com", password: "user-password-123" }),
    );
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ success: true, pending: true });

    const users = await listUsers(env.DB, getTablePrefix(env));
    const friend = users.find((u) => u.email === "friend@example.com");
    expect(friend?.role).toBe("user");
    expect(friend?.approval_status).toBe("pending");

    const pendingLogin = await request(
      env,
      "/api/auth/login",
      jsonInit("POST", { email: "friend@example.com", password: "user-password-123" }),
    );
    expect(pendingLogin.status).toBe(403);
    expect(pendingLogin.body).toMatchObject({ pending: true });
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

      // Tony 的复现路径：请求体回传占位符本身
      const setup = await request(
        env,
        "/api/setup",
        jsonInit("POST", { setup_secret: "SETUP_SECRET_PLACEHOLDER" }),
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
      jsonInit("POST", { setup_secret: "SETUP_SECRET_PLACEHOLDER" }),
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
      jsonInit("POST", { setup_secret: TEST_SETUP_SECRET }),
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
          body: JSON.stringify({ setup_secret: "SETUP_SECRET_PLACEHOLDER" }),
        },
        env,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Server misconfigured" });
      expect(await countUsers(env.DB, getTablePrefix(env))).toBe(0);
    }
  });
});

describe("并发注册竞态（ONE-313）", () => {
  it("并发注册只有一个能拿到管理员，另一个落为 user+pending", async () => {
    const env = makeEnv();
    await request(env, "/api/setup", setupInit());

    const [a, b] = await Promise.all([
      request(
        env,
        "/api/auth/register",
        jsonInit("POST", { email: "first@example.com", password: "admin-password-123" }),
      ),
      request(
        env,
        "/api/auth/register",
        jsonInit("POST", { email: "second@example.com", password: "user-password-123" }),
      ),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.pending, b.body.pending].sort()).toEqual([false, true]);

    const users = await listUsers(env.DB, getTablePrefix(env));
    expect(users).toHaveLength(2);
    expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
  });
});
