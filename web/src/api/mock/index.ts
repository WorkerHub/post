// 联调 mock 入口：形状与冻结契约一致，内存态、会话内有效。
// 接通真实接口后置 client.ts 的 USE_MOCK=false 即切换，本目录保留用于单测与离线手测。
export { resetMockStore, seedMockContacts, state } from "./store";
export { mockLettersApi, seedMockLetters } from "./letters";
export { mockContactsApi } from "./contacts";
export { mockAuthApi, mockGetMe } from "./auth";
export { mockSettingsApi, mockTwoFaApi } from "./settings";
export { mockAdminApi } from "./admin";
