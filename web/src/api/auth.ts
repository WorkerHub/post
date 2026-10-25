// 鉴权契约（ONE-172，照 eNotify 形态）：HttpOnly Cookie 会话 + JWT 双 token，
// 密码 + TOTP + Passkey。注册开放但默认待批准（SPEC §3）。
// 路由：POST /api/auth/register | login | logout；POST /api/auth/2fa/verify 等。
import type { MeProfile } from "./settings";

/** 登录结果：需要 2FA 时返回 tempToken 与可用方法；否则直接返回用户档案。 */
export type LoginResult =
  | { requires2fa: true; tempToken: string; availableMethods: string[] }
  | { requires2fa: false; user: MeProfile };

export interface AuthApi {
  login(email: string, password: string): Promise<LoginResult>;
  register(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** 登录态 2FA 校验（TOTP 六位码）。 */
  verify2fa(tempToken: string, method: string, code: string): Promise<MeProfile>;
  /** 登录态 Passkey：取认证 options，交浏览器 startAuthentication 后回传验证。 */
  passkeyAuthenticateOptions(tempToken: string): Promise<unknown>;
  passkeyAuthenticateVerify(tempToken: string, body: unknown): Promise<MeProfile>;
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

export const httpAuthApi: AuthApi = {
  async login(email, password) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as {
      requires2fa?: boolean;
      tempToken?: string;
      availableMethods?: string[];
      user?: MeProfile;
    };
    if (body.requires2fa) {
      return {
        requires2fa: true,
        tempToken: body.tempToken!,
        availableMethods: body.availableMethods ?? [],
      };
    }
    return { requires2fa: false, user: body.user! };
  },
  async register(email, password) {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await parseError(res);
  },
  async logout() {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    if (!res.ok) throw await parseError(res);
  },
  async verify2fa(tempToken, method, code) {
    const res = await fetch("/api/auth/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tempToken, method, code }),
    });
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { user: MeProfile };
    return body.user;
  },
  async passkeyAuthenticateOptions(tempToken) {
    const res = await fetch("/api/auth/2fa/passkey/authenticate/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tempToken }),
    });
    if (!res.ok) throw await parseError(res);
    return await res.json();
  },
  async passkeyAuthenticateVerify(tempToken, body) {
    const res = await fetch("/api/auth/2fa/passkey/authenticate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tempToken, ...(body as object) }),
    });
    if (!res.ok) throw await parseError(res);
    const json = (await res.json()) as { user: MeProfile };
    return json.user;
  },
};
