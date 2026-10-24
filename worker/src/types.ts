export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  SETUP_SECRET: string;
  ASSETS: Fetcher;
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
