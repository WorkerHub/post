// 联调 mock：个人设置（getMe/updateMe）+ TOTP/Passkey 管理。
import type { ProfilePatch, SettingsApi, TotpSetup, TwoFaApi } from "../settings";
import { state, toMeProfile } from "./store";

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

function sessionAccount() {
  if (!state.sessionEmail) return null;
  return state.accounts.find((a) => a.email === state.sessionEmail) ?? null;
}

export const mockSettingsApi: SettingsApi = {
  async fetchMe() {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    return toMeProfile(account);
  },
  async getSettings() {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    return toMeProfile(account);
  },
  async updateSettings(patch: ProfilePatch) {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    if (patch.display_name !== undefined) {
      if (patch.display_name.trim().length > 50) {
        throw new Error("Display name must be at most 50 characters");
      }
      account.display_name = patch.display_name.trim();
    }
    if (patch.timezone !== undefined) {
      if (!patch.timezone) throw new Error("Invalid timezone");
      account.timezone = patch.timezone;
    }
    if (patch.language !== undefined) {
      if (!["zh", "en"].includes(patch.language)) throw new Error("Invalid language");
      account.language = patch.language;
    }
  },
};

export const mockTwoFaApi: TwoFaApi = {
  async totpSetup(): Promise<TotpSetup> {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    state.twofa.pendingTotpSecret = TOTP_SECRET;
    return {
      secret: TOTP_SECRET,
      uri: `otpauth://totp/someday:${account.email}?secret=${TOTP_SECRET}&issuer=someday`,
    };
  },
  async totpEnable(code) {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    if (!code || code.length < 6) throw new Error("Invalid code");
    if (!state.twofa.pendingTotpSecret) throw new Error("No pending TOTP setup");
    state.twofa.totp_enabled = true;
    state.twofa.pendingTotpSecret = null;
  },
  async totpDisable(password) {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    if (account.password !== password) throw new Error("Password is incorrect");
    state.twofa.totp_enabled = false;
  },
  async passkeyRegisterOptions() {
    if (!sessionAccount()) throw new Error("401");
    // mock 模式不走 WebAuthn 仪式，由页面直接调 verify（见 USE_MOCK 分支）
    return { mock: true };
  },
  async passkeyRegisterVerify() {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    state.twofa.passkey_enabled = true;
  },
  async passkeyDisable(password) {
    const account = sessionAccount();
    if (!account) throw new Error("401");
    if (account.password !== password) throw new Error("Password is incorrect");
    state.twofa.passkey_enabled = false;
  },
};
