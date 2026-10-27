// waker 回调入口的路由（ONE-566）：把 SDK 的 receiver 子应用挂到 `/_waker`。
//
// 接入形态按 waker SPEC §4 / SDK 现行实现：`app.route(CALLBACK_MOUNT_PATH, createWakerReceiver(...))`，
// 平台同步 POST `/_waker/execute`。路径、验签、幂等、错误码全部由 SDK 决定，本文件不复制协议。
//
// 为什么按请求构造：someday 的 app 是模块级单例（`export const app`），env 在请求期才可见，
// 而 receiver 要按 env 取 signing key（secrets）与 D1 账本（`{prefix}waker_executions`）。
// 构造只是建对象、不做任何 IO，按请求构造不引入实际开销。

import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createWakerCallbackReceiver } from "../services/waker-callback";
import { CALLBACK_MOUNT_PATH } from "../waker";

/**
 * 把一个请求交给 SDK 的 receiver。
 *
 * receiver 自己的路由表是相对挂载前缀的（`POST /execute`），所以必须经 `app.route(前缀, receiver)`
 * 挂载才会命中——这里用一个临时的 Hono 宿主按 SDK 的挂载方式接上（路径剥离、未声明路径的 404
 * 都由 Hono + SDK 决定，不是手写的转发逻辑）。
 */
function forwardToReceiver(
  request: Request,
  env: HonoEnv["Bindings"],
): Response | Promise<Response> {
  const host = new Hono<HonoEnv>();
  host.route(
    CALLBACK_MOUNT_PATH,
    createWakerCallbackReceiver(env) as unknown as Hono<HonoEnv>,
  );
  return host.fetch(request, env);
}

/** `/_waker` 子应用（在 index.ts 里 `app.route(CALLBACK_MOUNT_PATH, wakerCallbackRoutes())`）。 */
export function wakerCallbackRoutes(): Hono<HonoEnv> {
  const routes = new Hono<HonoEnv>();
  routes.all("*", (c) => forwardToReceiver(c.req.raw, c.env));
  return routes;
}
