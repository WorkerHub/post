// 个人设置契约（ONE-176 冻结清单，与后端④ PR #10 对齐，不得私下变更）：
// - GET/PUT /api/settings/me：设置页（昵称/时区/语言）读写，字段 display_name/timezone/language。
// - GET /api/me：仅供 SessionBootstrap 鉴权自举，不用于设置读写（两者后端同源，见 index.ts）。
// TOTP/Passkey 管理路由照 eNotify 移植形态（/api/auth/2fa/*）。

export type Role = "admin" | "user";

export interface TwoFAStatus {
  totp_enabled: boolean;
  passkey_enabled: boolean;
  preferred_method: string | null;
}

/** GET /api/me（自举）与 GET /api/settings/me（设置读取）返回的当前用户档案。 */
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

/** PUT /api/settings/me 载荷（昵称/时区/语言，字段可部分更新）。 */
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
  /** SessionBootstrap 鉴权自举：GET /api/me（只判登录态与取档案，不用于设置读写）。 */
  fetchMe(): Promise<MeProfile>;
  /** 设置页读取：GET /api/settings/me。 */
  getSettings(): Promise<MeProfile>;
  /** 设置页写入（昵称/时区/语言）：PUT /api/settings/me。 */
  updateSettings(patch: ProfilePatch): Promise<void>;
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

async function fetchProfile(url: string): Promise<MeProfile> {
  const res = await fetch(url);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as MeProfile;
}

export const httpSettingsApi: SettingsApi = {
  async fetchMe() {
    return fetchProfile("/api/me");
  },
  async getSettings() {
    return fetchProfile("/api/settings/me");
  },
  async updateSettings(patch) {
    const res = await fetch("/api/settings/me", {
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
