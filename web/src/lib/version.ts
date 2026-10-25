/**
 * 构建期注入的版本与构建时间，集中从这里读取。
 *
 * 两个全局常量由 `web/vite.config.ts` 的 `define` 在构建期静态替换：
 * - `__APP_VERSION__`  形如 `v{version}-{build}-{shortsha}`
 * - `__APP_BUILD_TIME__` 构建时刻 ISO 字符串（UTC）
 *
 * footer（公开墙）与后续「关于页」共用本模块，避免各自再拼一遍版本串。
 */

/** 形如 `v0.1.0-128-eb5c718`；本地无构建号时为 `v0.1.0-0-<sha>`，无 git 时为 `v0.1.0-0-unknown`。 */
export const APP_VERSION: string = __APP_VERSION__;

/** 构建时刻（ISO 8601，UTC）。 */
export const APP_BUILD_TIME: string = __APP_BUILD_TIME__;
