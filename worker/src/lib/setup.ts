import type { Env } from "../types";
import { getTablePrefix } from "../types";
import { countUsers, getSetting, setSetting } from "../db/queries/users";

// setup 口径（SPEC §3，对齐 nav）：setup 只在首个账号创建前可用。
// 首个账号由 POST /api/setup（X-Setup-Secret）创建，即管理员；创建后落
// setup_page_enabled=0 硬关。防绕过：即使开关被改回 1，users 非空时仍判定已关闭。
// 表尚未建（全新部署）时视为可用，由 setup 接口内联建表。

export const SETUP_FLAG_KEY = "setup_page_enabled";

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
