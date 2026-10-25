// API 门面：生产（vite build）走真实 http API；单测（vitest）走同形状 mock。
// 接通/切换依据 import.meta.env.MODE，不在源码里手工改开关。
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

// vitest 运行环境 MODE === "test"，其余（vite build → production）一律走真实 HTTP API。
const USE_MOCK = import.meta.env.MODE === "test";

export const lettersApi: LettersApi = USE_MOCK ? mockLettersApi : httpLettersApi;
export const contactsApi: ContactsApi = USE_MOCK ? mockContactsApi : httpContactsApi;
export const authApi: AuthApi = USE_MOCK ? mockAuthApi : httpAuthApi;
export const settingsApi: SettingsApi = USE_MOCK ? mockSettingsApi : httpSettingsApi;
export const twoFaApi: TwoFaApi = USE_MOCK ? mockTwoFaApi : httpTwoFaApi;
export const adminApi: AdminApi = USE_MOCK ? mockAdminApi : httpAdminApi;

/** 当前是否运行在联调 mock 模式（Passkey 等 WebAuthn 仪式在 mock 下走简化路径）。 */
export const IS_MOCK = USE_MOCK;
