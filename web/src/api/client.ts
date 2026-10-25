// API 门面：后端④（letters/contacts/settings/admin 业务路由）就绪前用同形状 mock，
// 接通后把 USE_MOCK 置 false 即切换到真实 fetch。
// 见 ONE-175 / ONE-177 交付评论的交接说明。
import { httpAuthApi, type AuthApi } from "./auth";
import { httpAdminApi, type AdminApi } from "./admin";
import { httpContactsApi, type ContactsApi } from "./contacts";
import { httpLettersApi, type LettersApi } from "./letters";
import { httpSettingsApi, httpTwoFaApi, type SettingsApi, type TwoFaApi } from "./settings";
import {
  mockAdminApi,
  mockAuthApi,
  mockContactsApi,
  mockLettersApi,
  mockSettingsApi,
  mockTwoFaApi,
} from "./mock";

const USE_MOCK = true;

export const lettersApi: LettersApi = USE_MOCK ? mockLettersApi : httpLettersApi;
export const contactsApi: ContactsApi = USE_MOCK ? mockContactsApi : httpContactsApi;
export const authApi: AuthApi = USE_MOCK ? mockAuthApi : httpAuthApi;
export const settingsApi: SettingsApi = USE_MOCK ? mockSettingsApi : httpSettingsApi;
export const twoFaApi: TwoFaApi = USE_MOCK ? mockTwoFaApi : httpTwoFaApi;
export const adminApi: AdminApi = USE_MOCK ? mockAdminApi : httpAdminApi;

/** 当前是否运行在联调 mock 模式（Passkey 等 WebAuthn 仪式在 mock 下走简化路径）。 */
export const IS_MOCK = USE_MOCK;
