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
import { getMigrations } from "../src/db/migrations";
import { getSetting } from "../src/db/queries/users";
import { SETUP_SWITCH_KEY, setSetupPageEnabled } from "../src/lib/setup";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PW = "admin-test-pw-319";
const USER_EMAIL = "user@example.com";
const USER_PW = "user-test-pw-319";

/** 初始化 + 首账号（admin）+ 登录，返回管理员 Cookie 头。 */
async function adminEnv(overrides: Record<string, unknown> = {}) {
  const env = makeEnv(overrides);
  await doSetup(env, ADMIN_EMAIL, ADMIN_PW);
  const cookies = await loginAndGetCookies(env, ADMIN_EMAIL, ADMIN_PW);
  return { env, admin: cookieHeader(["access_token", cookies.access_token]) };
}

/** 再注册一个普通用户（已批准）+ 登录，返回其 Cookie 头。 */
async function normalUserHeader(env: Env, admin: Record<string, string>) {
  await registerAndApprove(env, admin, USER_EMAIL, USER_PW);
  const cookies = await loginAndGetCookies(env, USER_EMAIL, USER_PW);
  return cookieHeader(["access_token", cookies.access_token]);
}

describe("POST /api/admin/db-upgrade（ONE-319：免 SETUP_SECRET 升级数据库）", () => {
  it("未登录 401 / 非管理员 403", async () => {
    const { env, admin } = await adminEnv();

    const anon = await request(env, "/api/admin/db-upgrade", { method: "POST" });
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({ error: "Unauthorized" });

    const user = await normalUserHeader(env, admin);
    const forbidden = await request(env, "/api/admin/db-upgrade", {
      method: "POST",
      headers: user,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.success).toBeUndefined();
  });

  it("管理员可调用，返回 {success:true} 与迁移摘要（ONE-347 账本口径）", async () => {
    const { env, admin } = await adminEnv();
    const { status, body } = await request(env, "/api/admin/db-upgrade", {
      method: "POST",
      headers: admin,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.table_prefix).toBe("post_");
    // 已初始化过的库（账本已记全部迁移）→ 本次全部 skipped
    expect(body.applied).toBe(0);
    expect(body.skipped).toBe(getMigrations("post_").length);
    expect(body.migrations).toEqual(
      getMigrations("post_").map((m) => ({ name: m.name, status: "skipped" })),
    );
  });

  it("幂等：重复调用结果一致，且不破坏既有数据与设置", async () => {
    const { env, admin } = await adminEnv();

    // 升级前先制造数据：一封公开信 + 一条 smtp 设置
    const letter = await request(
      env,
      "/api/letters",
      jsonInit(
        "POST",
        { title: "升级前建的信", body_html: "<p>hi</p>", is_public: true },
        admin,
      ),
    );
    expect(letter.status).toBe(201);
    await request(
      env,
      "/api/admin/setup-switch",
      jsonInit("POST", { enabled: false }, admin),
    );

    const first = await request(env, "/api/admin/db-upgrade", {
      method: "POST",
      headers: admin,
    });
    const second = await request(env, "/api/admin/db-upgrade", {
      method: "POST",
      headers: admin,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    // 数据与设置都还在：信可读、开关值未被升级重置、会话仍有效
    const fetched = await request(env, `/api/letters/${letter.body.id}`, {
      headers: admin,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body.title).toBe("升级前建的信");
    expect(
      await getSetting(env.DB, getTablePrefix(env), SETUP_SWITCH_KEY),
    ).toBe("0");
    expect((await request(env, "/api/me", { headers: admin })).status).toBe(200);
  });

  it("按生效表前缀升级（自定义 TABLE_PREFIX 时不建裸表名）", async () => {
    const { env, admin } = await adminEnv({ TABLE_PREFIX: "t319_" });
    const { status, body } = await request(env, "/api/admin/db-upgrade", {
      method: "POST",
      headers: admin,
    });
    expect(status).toBe(200);
    expect(body.table_prefix).toBe("t319_");

    const names = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'",
      ).all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(names).toContain("t319_system_settings");
    expect(names).not.toContain("users");
    expect(names).not.toContain("system_settings");
  });
});

describe("setup 页面开关（ONE-319）", () => {
  it("未登录 401 / 非管理员 403（读写都要管理员）", async () => {
    const { env, admin } = await adminEnv();
    const user = await normalUserHeader(env, admin);

    expect((await request(env, "/api/admin/setup-switch")).status).toBe(401);
    expect(
      (
        await request(env, "/api/admin/setup-switch", jsonInit("POST", { enabled: false }))
      ).status,
    ).toBe(401);

    expect(
      (await request(env, "/api/admin/setup-switch", { headers: user })).status,
    ).toBe(403);
    expect(
      (
        await request(
          env,
          "/api/admin/setup-switch",
          jsonInit("POST", { enabled: false }, user),
        )
      ).status,
    ).toBe(403);

    // 非管理员的写入不生效
    expect((await request(env, "/api/admin/setup-switch", { headers: admin })).body).toEqual(
      { enabled: true },
    );
  });

  it("默认 ON；关闭后 /api/setup/state 404，重新打开恢复既有逻辑", async () => {
    const { env, admin } = await adminEnv();

    const initial = await request(env, "/api/admin/setup-switch", { headers: admin });
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ enabled: true });

    // 初始化已完成，开关 ON 时沿用既有 isSetupAvailable 逻辑
    expect((await request(env, "/api/setup/state")).body).toEqual({ enabled: false });

    const off = await request(
      env,
      "/api/admin/setup-switch",
      jsonInit("POST", { enabled: false }, admin),
    );
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ success: true, enabled: false });
    expect((await request(env, "/api/admin/setup-switch", { headers: admin })).body).toEqual(
      { enabled: false },
    );

    // 关闭 → 404，且不返回任何 setup 状态字段
    const stateOff = await request(env, "/api/setup/state");
    expect(stateOff.status).toBe(404);
    expect(stateOff.body).toEqual({ error: "Not found" });

    // 持久化在 system_settings（与 SMTP 配置同一存储模式），重开进程/请求后仍生效
    expect(await getSetting(env.DB, getTablePrefix(env), SETUP_SWITCH_KEY)).toBe("0");

    const on = await request(
      env,
      "/api/admin/setup-switch",
      jsonInit("POST", { enabled: true }, admin),
    );
    expect(on.body).toEqual({ success: true, enabled: true });
    expect((await request(env, "/api/setup/state")).body).toEqual({ enabled: false });
  });

  it("开关 ON：/api/setup/state 回到 isSetupAvailable 语义（全新部署仍 enabled:true）", async () => {
    const env = makeEnv();
    // 全新部署（没有任何账号）直接把开关打开写一次，state 照旧报告需要初始化
    await setSetupPageEnabled(env, true);
    expect((await request(env, "/api/setup/state")).body).toEqual({ enabled: true });

    // 关闭后，未初始化的部署同样 404
    await setSetupPageEnabled(env, false);
    const state = await request(env, "/api/setup/state");
    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "Not found" });
  });

  it("请求体不是布尔值 → 400，不改动开关", async () => {
    const { env, admin } = await adminEnv();

    for (const body of [{}, { enabled: "false" }, { enabled: 0 }]) {
      const res = await request(
        env,
        "/api/admin/setup-switch",
        jsonInit("POST", body, admin),
      );
      expect(res.status).toBe(400);
    }

    expect((await request(env, "/api/admin/setup-switch", { headers: admin })).body).toEqual(
      { enabled: true },
    );
  });
});
