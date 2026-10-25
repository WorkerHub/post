// 个人设置契约（ONE-172/ONE-176，与后端对齐，不得私下变更）：
// 后端②已落地 GET/PUT /api/me（昵称/时区/语言 + 2FA 状态）；
// TOTP/Passkey 管理路由照 eNotify 移植形态（/api/auth/2fa/*）。
// 注意：ONE-176 冻结清单写作 `GET/PUT /api/settings/me`，实际 stage 2 落地的路由是
// `/api/me`，前端按已落地的真实路由对接（见 ONE-177 交付评论说明）。

export type Role = "admin" | "user";

export interface TwoFAStatus {
  totp_enabled: boolean;
  passkey_enabled: boolean;
  preferred_method: string | null;
}

/** GET /api/me 返回的当前用户档案（登录后会话内自描述）。 */
export interface MeProfile {
  id: string;
  email: string;
  role: Role;
  is_active: boolean;
  approval_status: string;
  display_name: string;
  timezone: string;
  language: string;
  created_at: string;
  twofa: TwoFAStatus;
}

/** PUT /api/me 载荷（昵称/时区/语言，字段可部分更新）。 */
export interface ProfilePatch {
  display_name?: string;
  timezone?: string;
  language?: string;
}

/** TOTP 开通用：POST /api/auth/2fa/totp/setup 返回的 secret 与 otpauth:// URI。 */
export interface TotpSetup {
  secret: string;
  uri: string;
}

export interface SettingsApi {
  getMe(): Promise<MeProfile>;
  updateMe(patch: ProfilePatch): Promise<void>;
}

/** TOTP/Passkey 管理（设置页「安全」区块）。 */
export interface TwoFaApi {
  totpSetup(): Promise<TotpSetup>;
  totpEnable(code: string): Promise<void>;
  totpDisable(password: string): Promise<void>;
  passkeyRegisterOptions(): Promise<unknown>;
  passkeyRegisterVerify(body: unknown): Promise<void>;
  passkeyDisable(password: string): Promise<void>;
}

async function parseError(res: Response): Promise<Error> {
  let message = `${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // 非 JSON 错误体，忽略
  }
  return new Error(message);
}

export const httpSettingsApi: SettingsApi = {
  async getMe() {
    const res = await fetch("/api/me");
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as MeProfile;
  },
  async updateMe(patch) {
    const res = await fetch("/api/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await parseError(res);
  },
};

export const httpTwoFaApi: TwoFaApi = {
  async totpSetup() {
    const res = await fetch("/api/auth/2fa/totp/setup", { method: "POST" });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as TotpSetup;
  },
  async totpEnable(code) {
    const res = await fetch("/api/auth/2fa/totp/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw await parseError(res);
  },
  async totpDisable(password) {
    const res = await fetch("/api/auth/2fa/totp/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw await parseError(res);
  },
  async passkeyRegisterOptions() {
    const res = await fetch("/api/auth/2fa/passkey/register/options", {
      method: "POST",
    });
    if (!res.ok) throw await parseError(res);
    return await res.json();
  },
  async passkeyRegisterVerify(body) {
    const res = await fetch("/api/auth/2fa/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
  },
  async passkeyDisable(password) {
    const res = await fetch("/api/auth/2fa/passkey/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw await parseError(res);
  },
};
