// 接口联调（真实 HTTP）：本地 node:http 桩服务实现 ONE-319/ONE-320 冻结的三个管理端端点，
// 让 httpAdminApi / httpSetupApi 走真实的 fetch → 状态码 → JSON 解析链路，验证：
// - 请求方法/路径/body 字段名与契约一致（setup-switch 的 body 只有 `enabled`；db-upgrade 无 body）
// - db-upgrade 摘要按后端返回原样展示（已知键翻中文标签，未知键保留原名）
// - setup 开关 OFF 时 GET /api/setup/state 回 404（页面据此渲染 404 视图），ON 恢复既有行为
// - 未登录 / 非管理员（401/403）都被识别并带状态码
// 桩服务只实现契约本身，不含任何业务实现。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { httpAdminApi } from "./admin";
import { httpSetupApi } from "./setup";

const requests: Array<{ method: string; path: string; body: unknown }> = [];

/** 桩服务的会话视角：admin / user / none（未登录）。 */
let actor: "admin" | "user" | "none" = "admin";
/** setup 页面开关（默认 ON）。 */
let setupSwitch = true;
/** 本站是否需要初始化（GET /api/setup/state 的 enabled）。 */
let setupPending = false;
/** db-upgrade 的响应形态：ok / forbidden / body-failure。 */
let dbUpgradeMode: "ok" | "body-failure" = "ok";
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

/** 管理端统一鉴权：未登录 401，非管理员 403。 */
function guard(res: ServerResponse): boolean {
  if (actor === "none") {
    send(res, 401, { error: "Unauthorized" });
    return false;
  }
  if (actor !== "admin") {
    send(res, 403, { error: "Forbidden" });
    return false;
  }
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "").split("?")[0];
  const body = await readBody(req);
  requests.push({ method: req.method ?? "", path, body });

  if (path === "/api/admin/db-upgrade" && req.method === "POST") {
    if (!guard(res)) return;
    if (dbUpgradeMode === "body-failure") {
      return send(res, 200, { success: false, message: "schema drift detected" });
    }
    // 成功态：{success:true, ...摘要}——已知键 + 一个契约未列名的键
    return send(res, 200, {
      success: true,
      table_prefix: "post_",
      statements: 72,
      indexes_created: 4,
    });
  }

  if (path === "/api/admin/setup-switch" && req.method === "GET") {
    if (!guard(res)) return;
    return send(res, 200, { enabled: setupSwitch });
  }

  if (path === "/api/admin/setup-switch" && req.method === "POST") {
    if (!guard(res)) return;
    const { enabled } = (body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return send(res, 400, { error: "enabled must be boolean" });
    }
    setupSwitch = enabled;
    return send(res, 200, { success: true, enabled });
  }

  // 开关 OFF：init 状态接口直接 404，不吐任何状态信息
  if (path === "/api/setup/state" && req.method === "GET") {
    if (!setupSwitch) return send(res, 404, { error: "Not found" });
    return send(res, 200, { enabled: setupPending });
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

beforeEach(() => {
  actor = "admin";
  setupSwitch = true;
  setupPending = false;
  dbUpgradeMode = "ok";
  requests.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("系统维护接口联调（真实 HTTP，契约 ONE-319 / ONE-320）", () => {
  it("db-upgrade：POST 无 body，摘要按后端返回展示（已知键翻标签，未知键保原名）", async () => {
    await expect(httpAdminApi.dbUpgrade()).resolves.toEqual({
      success: true,
      summary: [
        { label: "表前缀", value: "post_" },
        { label: "执行语句数", value: "72" },
        { label: "indexes_created", value: "4" },
      ],
      message: null,
    });
    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/admin/db-upgrade",
      body: undefined,
    });
  });

  it("db-upgrade：200 但 success:false → 当作失败并回显 message", async () => {
    dbUpgradeMode = "body-failure";
    await expect(httpAdminApi.dbUpgrade()).resolves.toMatchObject({
      success: false,
      message: "schema drift detected",
    });
  });

  it("db-upgrade：非管理员 403 / 未登录 401 → 抛带原文的错误", async () => {
    actor = "user";
    await expect(httpAdminApi.dbUpgrade()).rejects.toThrow("Forbidden");
    actor = "none";
    await expect(httpAdminApi.dbUpgrade()).rejects.toThrow("Unauthorized");
  });

  it("setup-switch：读写只带 enabled 字段，OFF 时 /api/setup/state 404，ON 恢复", async () => {
    // 1) 默认 ON，本站已初始化 → 既有行为：enabled=false
    await expect(httpAdminApi.getSetupSwitch()).resolves.toEqual({ enabled: true });
    await expect(httpSetupApi.fetchState()).resolves.toEqual({ enabled: false });

    // 2) 关闭开关：body 严格只有 {enabled:false}
    await expect(httpAdminApi.updateSetupSwitch(false)).resolves.toEqual({ enabled: false });
    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/admin/setup-switch",
      body: { enabled: false },
    });
    await expect(httpAdminApi.getSetupSwitch()).resolves.toEqual({ enabled: false });

    // 3) 关闭后浏览器访问 /setup 的判据：GET /api/setup/state 回 404（页面据此渲染 404 视图）
    await expect(httpSetupApi.fetchState()).rejects.toMatchObject({ status: 404 });

    // 4) 重新开启 → 恢复既有行为
    await expect(httpAdminApi.updateSetupSwitch(true)).resolves.toEqual({ enabled: true });
    setupPending = true;
    await expect(httpSetupApi.fetchState()).resolves.toEqual({ enabled: true });
  });

  it("setup-switch：非管理员 403 / 未登录 401", async () => {
    actor = "user";
    await expect(httpAdminApi.getSetupSwitch()).rejects.toThrow("Forbidden");
    await expect(httpAdminApi.updateSetupSwitch(false)).rejects.toThrow("Forbidden");
    actor = "none";
    await expect(httpAdminApi.getSetupSwitch()).rejects.toThrow("Unauthorized");
    await expect(httpAdminApi.updateSetupSwitch(true)).rejects.toThrow("Unauthorized");
    // 权限被拒时开关状态不应被改动
    expect(setupSwitch).toBe(true);
  });
});
