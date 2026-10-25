export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  SETUP_SECRET: string;
  ASSETS: Fetcher;
  /**
   * 表前缀（非 secret，GitHub Variables / Wrangler [vars] 注入）。
   * undefined → 默认 "post_"；"" → 显式无前缀；其他值需匹配 /^[a-z0-9_]*$/。
   */
  TABLE_PREFIX?: string;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    role: string;
  };
};

export interface JWTPayload {
  sub: string;
  role: string;
  jti: string;
  sid: string;
  exp: number;
  iat: number;
  needs_2fa_setup?: boolean;
  typ?: "access" | "refresh";
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: "admin" | "user";
  is_active: number;
  /** pending = 注册后待管理员批准；approved = 可登录使用 */
  approval_status: "pending" | "approved";
  /** 公开信墙显示昵称，空则显示「一位朋友」 */
  display_name: string;
  timezone: string;
  language: string;
  created_at: string;
  updated_at: string;
}

export interface User2FA {
  user_id: string;
  totp_secret: string | null;
  totp_enabled: number;
  passkey_credentials: string | null;
  passkey_enabled: number;
  email_otp_enabled: number;
  preferred_method: "totp" | "passkey" | "email_otp" | null;
  updated_at: string;
}

/** SPEC §4：status 流转 draft → scheduled → sending → sent / failed，scheduled 可回 draft 或置 cancelled */
export interface Letter {
  id: string;
  user_id: string;
  title: string;
  body_html: string;
  /** TipTap 文档 JSON，与 body_html 双存 */
  body_json: string;
  /** UTC ISO；草稿可空 */
  send_at: string | null;
  timezone: string;
  status: "draft" | "scheduled" | "sending" | "sent" | "failed" | "cancelled";
  is_public: number;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LetterRecipient {
  id: string;
  letter_id: string;
  contact_id: string | null;
  /** 保存时的快照，不随联系人后续修改变化 */
  name: string;
  email: string;
  status: "pending" | "sent" | "failed";
  error: string | null;
  sent_at: string | null;
}

export interface Contact {
  id: string;
  user_id: string;
  name: string;
  email: string;
  notes: string;
  /** JSON 数组 */
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface SystemSetting {
  key: string;
  value: string;
  updated_at: string;
}

// ─── 表前缀（ONE-269 冻结契约） ───────────────────────────────────────────────

/** 项目默认表前缀——全仓库唯一允许写死的表名常量。 */
export const DEFAULT_TABLE_PREFIX = "post_";

/** 小写字母 / 数字 / 下划线；尾部 "_" 由部署方在变量值里自带。 */
const TABLE_PREFIX_RE = /^[a-z0-9_]*$/;

export function isValidTablePrefix(prefix: string): boolean {
  return TABLE_PREFIX_RE.test(prefix);
}

/**
 * 表前缀三态解析（照 nav 现行实现）：
 * - undefined → DEFAULT_TABLE_PREFIX（"post_"）——共享 D1 零配置隔离；
 * - ""       → ""（显式无前缀，部署方自担表名冲突风险）；
 * - 其他     → 先经 isValidTablePrefix 校验，非法抛错；合法则原样返回配置值（不自动补下划线）。
 */
export function getTablePrefix(env: Pick<Env, "TABLE_PREFIX">): string {
  const raw = env.TABLE_PREFIX;
  if (raw === undefined) return DEFAULT_TABLE_PREFIX;
  if (raw === "") return "";
  if (!isValidTablePrefix(raw)) {
    throw new Error(`invalid TABLE_PREFIX "${raw}": must match /^[a-z0-9_]*$/`);
  }
  return raw;
}

/** 6 张表的解析后表名（对齐 Zeta tables(env) 形态），内部复用三态解析。 */
export function tables(env: Pick<Env, "TABLE_PREFIX">) {
  const p = getTablePrefix(env);
  return {
    users: `${p}users`,
    user_2fa: `${p}user_2fa`,
    letters: `${p}letters`,
    letter_recipients: `${p}letter_recipients`,
    contacts: `${p}contacts`,
    system_settings: `${p}system_settings`,
  };
}
