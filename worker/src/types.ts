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
  /**
   * waker 项目 signing key（回调验签用，ONE-566）：只来自 secrets（GitHub Secrets →
   * `wrangler deploy --secrets-file`），绝不进 [vars]、不进仓库。
   * 未配置时回调入口 fail closed（500 `signing_key_missing`），不影响其它路由。
   */
  WAKER_SIGNING_KEY?: string;
  /**
   * Resend webhook 的 Svix 签名密钥（whsec_…）：只来自 secrets，绝不进 [vars]、不进仓库。
   * 未配置时 `/api/resend/webhook` fail closed（401），不影响其它路由。
   */
  RESEND_WEBHOOK_SECRET?: string;
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
  /** 节流补遗 §3.2：限流退避的下次可尝试时刻（UTC ISO，可空）；空 = 可尝试 */
  next_attempt_at: string | null;
  /** 节流补遗 §3.2：限流类错误计数（不退避计入 attempts） */
  throttle_attempts: number;
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
  /** 节流补遗 §3.3：该副本投递时使用的 Message-ID（成功后落库，可空） */
  message_id: string | null;
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

/**
 * 前缀核：业务表前缀去掉尾部下划线（`post_` → `post`，`""` → `""`）。
 * 大小写原值保留，不做任何规范化——表名一旦落库即固定。
 */
export function prefixCore(prefix: string): string {
  return prefix.endsWith("_")
    ? prefix.slice(0, prefix.length - 1)
    : prefix;
}

/** 业务表名：前缀 + 表名（前缀自带尾部 `_`，见三态解析）。 */
export function tbl(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

/**
 * 迁移账本表名（ONE-347 冻结契约）：`_` + 前缀核 + `_schema_migrations`，
 * 空前缀时为 `_schema_migrations`（例：`post_` → `_post_schema_migrations`）。
 *
 * 这是**唯一**允许生成账本表名的入口：严禁在任何地方散落拼接 `_${prefix}_schema_migrations`。
 */
export function migrationsTable(prefix: string): string {
  const core = prefixCore(prefix);
  return core === "" ? "_schema_migrations" : `_${core}_schema_migrations`;
}

/** 6 张表的解析后表名（对齐 Zeta tables(env) 形态），内部复用三态解析。 */
export function tables(env: Pick<Env, "TABLE_PREFIX">) {
  const p = getTablePrefix(env);
  return {
    users: tbl(p, "users"),
    user_2fa: tbl(p, "user_2fa"),
    letters: tbl(p, "letters"),
    letter_recipients: tbl(p, "letter_recipients"),
    contacts: tbl(p, "contacts"),
    system_settings: tbl(p, "system_settings"),
  };
}
