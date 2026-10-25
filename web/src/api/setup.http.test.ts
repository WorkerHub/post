// 接口联调（真实 HTTP）：用本地 node:http 桩服务实现 ONE-313 冻结核对的三个端点，
// 让 httpSetupApi / httpAuthApi 走真实的 fetch → 状态码 → JSON 解析链路，验证：
// - 请求方法/路径/body 字段名与契约一致（setup_secret；不新增字段）
// - 403（密钥错 / 未初始化注册）、500（服务端未配置）都被识别且带状态码
// - 完整序列：state(true) → 注册 403 → 错密钥 403 → 对密钥 200 → state(false)
//   → 首个注册管理员 → 第二个注册待批准
// 这是 CI 里可复现的联调证据；桩服务只实现契约本身，不含任何业务实现。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { httpAuthApi } from "./auth";
import { httpSetupApi } from "./setup";

const EXPECTED_SECRET = "contract-test-secret";
const PASSWORD = ["test", "pass", "123"].join("");
const requests: Array<{ method: string; path: string; body: unknown }> = [];

interface StubUser {
  email: string;
  role: "admin" | "user";
  approval_status: "approved" | "pending";
}

let users: StubUser[] = [];
let setupEnabled = true;
/** 模拟「服务端没有配置 SETUP_SECRET」的 500 分支。 */
let misconfigured = false;
let server: Server;
let base = "";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// 桩服务：严格按 ONE-313 冻结契约实现，不做任何额外宽松处理。
async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "").split("?")[0];
  const body = await readBody(req);
  requests.push({ method: req.method ?? "", path, body });

  if (path === "/api/setup/state" && req.method === "GET") {
    return send(res, 200, { enabled: setupEnabled });
  }

  if (path === "/api/setup" && req.method === "POST") {
    if (misconfigured) return send(res, 500, { error: "Server misconfigured" });
    const { setup_secret: setupSecret } = (body ?? {}) as { setup_secret?: string };
    if (!setupSecret || setupSecret !== EXPECTED_SECRET) {
      return send(res, 403, { error: "Invalid setup secret" });
    }
    if (!setupEnabled) return send(res, 403, { error: "Setup is closed" });
    // 只关开关，不建账号
    setupEnabled = false;
    return send(res, 200, { success: true });
  }

  if (path === "/api/auth/register" && req.method === "POST") {
    if (setupEnabled) {
      return send(res, 403, { error: "Setup required before registration" });
    }
    const { email } = (body ?? {}) as { email?: string };
    const isFirst = users.length === 0;
    const user: StubUser = {
      email: email ?? "",
      role: isFirst ? "admin" : "user",
      approval_status: isFirst ? "approved" : "pending",
    };
    users.push(user);
    // 响应形状照后端既有实现：首个账号回 user（role=admin/approved），其余带 pending
    return send(
      res,
      201,
      isFirst ? { success: true, user } : { success: true, pending: true },
    );
  }

  return send(res, 404, { error: "Not found" });
}

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 页面里的接口调用是相对路径，这里补上桩服务的 origin（仅测试态）
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(typeof input === "string" ? new URL(input, base) : input, init),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("setup / 注册 接口联调（真实 HTTP，契约 ONE-313）", () => {
  it("错误 secret 报错 → 正确 secret 完成初始化 → 首账号管理员 → 第二账号待批准", async () => {
    // 1) 全新部署：state.enabled = true
    await expect(httpSetupApi.fetchState()).resolves.toEqual({ enabled: true });

    // 2) 未初始化时注册被后端拒绝
    await expect(
      httpAuthApi.register("before@example.com", PASSWORD),
    ).rejects.toThrow("Setup required before registration");

    // 3) 错误 secret → 403，页面据此报「初始化密钥不正确」
    await expect(httpSetupApi.submit("wrong-secret")).rejects.toMatchObject({
      status: 403,
      message: "Invalid setup secret",
    });
    expect((await httpSetupApi.fetchState()).enabled).toBe(true);

    // 4) 正确 secret → 200，state 翻转，账号数仍为 0（初始化不建号）
    await expect(httpSetupApi.submit(EXPECTED_SECRET)).resolves.toBeUndefined();
    await expect(httpSetupApi.fetchState()).resolves.toEqual({ enabled: false });
    expect(users).toHaveLength(0);

    // 5) 首个注册账号 → 管理员（approved）
    await expect(
      httpAuthApi.register("first@example.com", PASSWORD),
    ).resolves.toEqual({ admin: true });

    // 6) 第二个注册账号 → 待批准
    await expect(
      httpAuthApi.register("second@example.com", PASSWORD),
    ).resolves.toEqual({ admin: false });

    // 请求侧核对：路径与 body 字段名严格符合冻结契约
    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/setup",
      body: { setup_secret: EXPECTED_SECRET },
    });
    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/auth/register",
      body: { email: "first@example.com", password: PASSWORD },
    });
  });

  it("服务端未配置 SETUP_SECRET（500）→ 抛带状态码的错供页面提示部署者", async () => {
    misconfigured = true;
    try {
      // 页面据此给出「联系部署者」文案（见 pages/setup.tsx 的 describeSetupError）
      await expect(httpSetupApi.submit(EXPECTED_SECRET)).rejects.toMatchObject({
        status: 500,
        message: "Server misconfigured",
      });
    } finally {
      misconfigured = false;
    }
  });
});
