import { describe, expect, it } from "vitest";
import { tables } from "../src/types";
import {
  cookieHeader,
  doSetup,
  jsonInit,
  loginAndGetCookies,
  makeEnv,
  request,
} from "./helpers";

// 发信节流参数的后台接口（节流补遗 §3.1.4）：GET/PUT /api/admin/settings/send-throttle。
// v1 不做设置页 UI，接口可改即可；写入严格校验、读取逐项回退。

async function adminEnv() {
  const env = makeEnv();
  await doSetup(env, "admin@example.com", "adminpass123");
  const cookies = await loginAndGetCookies(env, "admin@example.com", "adminpass123");
  return {
    env,
    admin: cookieHeader(["access_token", cookies.access_token]),
  };
}

async function storedConfig(env: Awaited<ReturnType<typeof adminEnv>>["env"]) {
  const row = await env.DB.prepare(
    `SELECT value FROM ${tables(env).system_settings} WHERE key = 'send_throttle_config'`,
  ).first<{ value: string }>();
  return row === null ? null : (JSON.parse(row.value) as Record<string, unknown>);
}

describe("发信节流参数后台接口（节流补遗 §3.1.4）", () => {
  it("未登录不可访问；GET 返回默认参数", async () => {
    const { env, admin } = await adminEnv();
    expect((await request(env, "/api/admin/settings/send-throttle")).status).toBe(401);

    const res = await request(env, "/api/admin/settings/send-throttle", {
      headers: admin,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      interval_ms: 4000,
      jitter_ms: 2000,
      max_recipients_per_run: 10,
    });
  });

  it("PUT 合法值 → 落库并回显；GET 读到生效值", async () => {
    const { env, admin } = await adminEnv();

    const put = await request(
      env,
      "/api/admin/settings/send-throttle",
      jsonInit("PUT", { interval_ms: 5000, jitter_ms: 1000 }, admin),
    );
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      interval_ms: 5000,
      jitter_ms: 1000,
      max_recipients_per_run: 10, // 未提供的字段保持当前生效值
    });
    expect(await storedConfig(env)).toEqual(put.body);

    const get = await request(env, "/api/admin/settings/send-throttle", {
      headers: admin,
    });
    expect(get.body).toEqual(put.body);
  });

  it("PUT 非法值（负数/非整数/越界）→ 400 且不落库", async () => {
    const { env, admin } = await adminEnv();

    for (const body of [
      { interval_ms: -1 },
      { jitter_ms: 1.5 },
      { max_recipients_per_run: 0 },
      { max_recipients_per_run: 101 },
      { interval_ms: "4000" },
    ]) {
      const res = await request(
        env,
        "/api/admin/settings/send-throttle",
        jsonInit("PUT", body, admin),
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    expect(await storedConfig(env)).toBeNull();
  });

  it("库里被直接写坏时 GET 仍返回默认参数（读取侧宽容）", async () => {
    const { env, admin } = await adminEnv();
    await env.DB.prepare(
      `INSERT INTO ${tables(env).system_settings} (key, value, updated_at)
       VALUES ('send_throttle_config', 'not-json', '2026-01-01')`,
    ).run();

    const res = await request(env, "/api/admin/settings/send-throttle", {
      headers: admin,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      interval_ms: 4000,
      jitter_ms: 2000,
      max_recipients_per_run: 10,
    });
  });
});
