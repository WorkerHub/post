// API 门面：后端④（letters/contacts 业务路由）就绪前用同形状 mock，
// 接通后把 USE_MOCK 置 false 即切换到真实 fetch（httpLettersApi/httpContactsApi）。
// 见 ONE-175 交付评论的交接说明。
import { httpContactsApi, type ContactsApi } from "./contacts";
import { httpLettersApi, type LettersApi } from "./letters";
import { mockContactsApi, mockLettersApi } from "./mock";

const USE_MOCK = true;

export const lettersApi: LettersApi = USE_MOCK ? mockLettersApi : httpLettersApi;
export const contactsApi: ContactsApi = USE_MOCK ? mockContactsApi : httpContactsApi;
