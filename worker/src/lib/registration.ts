import type { Env } from "../types";
import { getTablePrefix } from "../types";
import { getSetting, setSetting } from "../db/queries/users";

// 注册开关（ONE-330 冻结契约，post v1.1 需求 2）：后台管理设置里的「是否开启注册」，
// 默认开启。落既有 {prefix}system_settings 表（复用 getSetting/setSetting，不新增 schema/迁移），
// 键 allow_registration，值存字符串 "1"/"0" —— 与 setup_page_switch 的存法一致。
//
// 默认 ON：键缺失、值非 "0"、或表尚未建（全新部署读不到键）一律按开启处理。

export const REGISTRATION_KEY = "allow_registration";

export async function isRegistrationEnabled(env: Env): Promise<boolean> {
  const prefix = getTablePrefix(env);
  try {
    const flag = await getSetting(env.DB, prefix, REGISTRATION_KEY);
    return flag !== "0";
  } catch {
    return true;
  }
}

/** 写注册开关（落 {prefix}system_settings，键已在既有 schema 内，无需新表）。 */
export async function setRegistrationEnabled(
  env: Env,
  enabled: boolean,
): Promise<void> {
  await setSetting(
    env.DB,
    getTablePrefix(env),
    REGISTRATION_KEY,
    enabled ? "1" : "0",
  );
}
