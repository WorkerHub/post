import type { Env } from "../types";
import { getTablePrefix } from "../types";
import { countUsers, getSetting, setSetting } from "../db/queries/users";

// setup 口径（SPEC §3 + ONE-313 冻结契约）：可视化 setup 页只填 SETUP_SECRET 完成初始化，
// 不创建任何账号；初始化后落 setup_page_enabled=0 硬关。此后第一个通过页面注册的用户
// 成为管理员（role=admin, approval_status=approved），其余注册一律 user+pending。
// 防绕过：即使开关被改回 1，users 非空时仍判定已关闭。
// 表尚未建（全新部署）时视为可用，由 POST /api/setup 内联建表。
//
// 两个键的分工（ONE-319）：
// - SETUP_FLAG_KEY（setup_page_enabled）：**初始化完成标记**，由 POST /api/setup 写死为 0，
//   管理后台不改它，只作为 isSetupAvailable 的判据之一。
// - SETUP_SWITCH_KEY（setup_page_switch）：**管理后台的 setup 页开关**，默认 ON；
//   关闭后 /api/setup/state 一律 404（浏览器访问 setup 页即 404），与初始化状态无关。

export const SETUP_FLAG_KEY = "setup_page_enabled";
export const SETUP_SWITCH_KEY = "setup_page_switch";

export async function isSetupAvailable(env: Env): Promise<boolean> {
  const prefix = getTablePrefix(env);
  try {
    const flag = await getSetting(env.DB, prefix, SETUP_FLAG_KEY);
    if (flag === "0") return false;
    // 双保险：已有任何账号即视为 setup 已完成
    return (await countUsers(env.DB, prefix)) === 0;
  } catch {
    // 表未建/库不可读：按全新部署处理
    return true;
  }
}

export async function closeSetup(env: Env): Promise<void> {
  const prefix = getTablePrefix(env);
  await setSetting(env.DB, prefix, SETUP_FLAG_KEY, "0");
}

/**
 * setup 页面开关（管理后台可改，ONE-319 冻结契约）。
 * 默认 ON：键缺失、值非 "0"、或表尚未建（全新部署读不到键）一律按开启处理。
 */
export async function isSetupPageEnabled(env: Env): Promise<boolean> {
  const prefix = getTablePrefix(env);
  try {
    const flag = await getSetting(env.DB, prefix, SETUP_SWITCH_KEY);
    return flag !== "0";
  } catch {
    return true;
  }
}

/** 写 setup 页面开关（落 {prefix}system_settings，键已在既有 schema 内，无需新表）。 */
export async function setSetupPageEnabled(
  env: Env,
  enabled: boolean,
): Promise<void> {
  await setSetting(
    env.DB,
    getTablePrefix(env),
    SETUP_SWITCH_KEY,
    enabled ? "1" : "0",
  );
}
