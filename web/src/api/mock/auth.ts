// 联调 mock：鉴权（HttpOnly Cookie 会话形态的内存等价物）+ 登录态 2FA。
import type { AuthApi } from "../auth";
import type { MeProfile } from "../settings";
import { nextId, state, toMeProfile } from "./store";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function currentAccount(): MeProfile | null {
  if (!state.sessionEmail) return null;
  const account = state.accounts.find((a) => a.email === state.sessionEmail);
  return account ? toMeProfile(account) : null;
}

export const mockAuthApi: AuthApi = {
  async login(email, password) {
    const normalized = email.trim().toLowerCase();
    const account = state.accounts.find((a) => a.email === normalized);
    if (!account || account.password !== password) {
      throw new Error("Invalid credentials");
    }
    if (!account.is_active) throw new Error("Account is disabled");
    if (account.approval_status !== "approved") {
      throw new Error("Account pending approval");
    }
    if (state.twofa.totp_enabled || state.twofa.passkey_enabled) {
      const availableMethods: string[] = [];
      if (state.twofa.totp_enabled) availableMethods.push("totp");
      if (state.twofa.passkey_enabled) availableMethods.push("passkey");
      state.pendingLoginEmail = normalized;
      return { requires2fa: true, tempToken: "mock-token", availableMethods };
    }
    state.sessionEmail = normalized;
    return { requires2fa: false, user: toMeProfile(account) };
  },
  async register(email, password) {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw new Error("Invalid email format");
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    if (state.accounts.some((a) => a.email === normalized)) {
      throw new Error("Email already registered");
    }
    state.accounts.push({
      id: nextId("u"),
      email: normalized,
      role: "user",
      approval_status: "pending",
      is_active: true,
      display_name: "",
      timezone: "Asia/Shanghai",
      language: "zh",
      password,
      created_at: new Date().toISOString(),
    });
    // 待批准账号不签发会话，等管理员批准后再登录
  },
  async logout() {
    state.sessionEmail = null;
    state.pendingLoginEmail = null;
  },
  async verify2fa(tempToken, method, code) {
    if (tempToken !== "mock-token" || !state.pendingLoginEmail) {
      throw new Error("Invalid or expired 2FA session");
    }
    if (!code || code.length < 6) throw new Error("Invalid verification code");
    const account = state.accounts.find((a) => a.email === state.pendingLoginEmail);
    if (!account) throw new Error("Invalid or expired 2FA session");
    state.pendingLoginEmail = null;
    state.sessionEmail = account.email;
    return toMeProfile(account);
  },
  async passkeyAuthenticateOptions() {
    // mock 模式不走 WebAuthn 仪式，由页面直接调 verify（见 USE_MOCK 分支）
    return { mock: true };
  },
  async passkeyAuthenticateVerify(tempToken) {
    if (tempToken !== "mock-token" || !state.pendingLoginEmail) {
      throw new Error("Invalid or expired 2FA session");
    }
    const account = state.accounts.find((a) => a.email === state.pendingLoginEmail);
    if (!account) throw new Error("Invalid or expired 2FA session");
    state.pendingLoginEmail = null;
    state.sessionEmail = account.email;
    return toMeProfile(account);
  },
};

/** 供 RequireAuth/bootstrap 判定：mock 会话存在与否。 */
export function mockGetMe(): MeProfile | null {
  return currentAccount();
}
