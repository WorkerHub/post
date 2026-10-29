// 联调 mock 共享状态：内存态、会话内有效。接通真实接口后置 USE_MOCK=false 即切换，
// 本目录保留用于单测与离线手测（见 ONE-175/ONE-177 交付评论）。
import type { Contact } from "../contacts";
import type { Letter } from "../letters";
import type { MeProfile } from "../settings";
import type { AdminUser, ResendConfig, SmtpConfig } from "../admin";

export interface MockAccount {
  id: string;
  email: string;
  role: "admin" | "user";
  approval_status: "approved" | "pending";
  is_active: boolean;
  display_name: string;
  timezone: string;
  language: string;
  password: string;
  created_at: string;
}

export interface MockTwoFa {
  totp_enabled: boolean;
  passkey_enabled: boolean;
  pendingTotpSecret: string | null;
}

export interface MockState {
  seq: number;
  letters: Map<string, Letter>;
  contacts: Contact[];
  accounts: MockAccount[];
  sessionEmail: string | null;
  pendingLoginEmail: string | null;
  twofa: MockTwoFa;
  smtp: SmtpConfig;
  /** Resend 发信渠道（默认 SMTP，与后端缺省一致）。 */
  resend: ResendConfig;
  /** mock 内部保存的原始 token（脱敏视图 resend 由它派生，真实后端永不下发原文）。 */
  resendTokens: Record<string, string>;
  /** setup（GET /api/setup/state）状态：true = 尚未初始化，无任何账号。 */
  setupEnabled: boolean;
  /** setup 页面开关（/api/admin/setup-switch）：false 时 GET /api/setup/state 返回 404。默认 ON。 */
  setupSwitchEnabled: boolean;
  /** 注册开关（/api/admin/registration、GET /api/auth/registration-state）：默认 ON。 */
  registrationEnabled: boolean;
  /** db-upgrade（/api/admin/db-upgrade）被调用的次数：供单测断言按钮确实打了接口。 */
  dbUpgradeCalls: number;
  /** 联调 mock 的初始化密钥（仅内存态；真实密钥只在部署环境的 secret 里）。 */
  setupExpectedSecret: string;
}

const DEFAULT_SMTP: SmtpConfig = {
  host: "smtp.example.com",
  port: 465,
  username: "someday@example.com",
  password: "", // 空串表示未配置（脱敏回显也不含明文）
  password_set: false,
  from: "someday@example.com",
  from_name: "时光邮局",
};

const DEFAULT_RESEND: ResendConfig = {
  channel: "smtp",
  resend_tokens: {},
  tokens_set: {},
};

function buildAccounts(): MockAccount[] {
  return [
    {
      id: "u-admin",
      email: "admin@example.com",
      role: "admin",
      approval_status: "approved",
      is_active: true,
      display_name: "管理员",
      timezone: "Asia/Shanghai",
      language: "zh",
      password: "admin123456",
      created_at: "2026-10-24T00:00:00.000Z",
    },
    {
      id: "u-user",
      email: "user@example.com",
      role: "user",
      approval_status: "approved",
      is_active: true,
      display_name: "",
      timezone: "Asia/Shanghai",
      language: "zh",
      password: "user123456",
      created_at: "2026-10-24T00:00:00.000Z",
    },
    {
      id: "u-pending",
      email: "pending@example.com",
      role: "user",
      approval_status: "pending",
      is_active: true,
      display_name: "",
      timezone: "Asia/Shanghai",
      language: "zh",
      password: "pending123456",
      created_at: "2026-10-24T00:00:00.000Z",
    },
  ];
}

export const MOCK_SETUP_SECRET = "mock-setup-secret";

export const state: MockState = {
  seq: 0,
  letters: new Map(),
  contacts: [],
  accounts: buildAccounts(),
  sessionEmail: null,
  pendingLoginEmail: null,
  twofa: { totp_enabled: false, passkey_enabled: false, pendingTotpSecret: null },
  smtp: { ...DEFAULT_SMTP },
  resend: { ...DEFAULT_RESEND },
  resendTokens: {},
  // 默认 mock 场景是「已上线、已有账号」；全新部署用 seedFreshDeployment() 重置。
  setupEnabled: false,
  setupSwitchEnabled: true,
  registrationEnabled: true,
  dbUpgradeCalls: 0,
  setupExpectedSecret: MOCK_SETUP_SECRET,
};

export function nextId(prefix: string): string {
  state.seq += 1;
  return `${prefix}-${state.seq}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** 单测/手测间重置内存态。 */
export function resetMockStore(): void {
  state.seq = 0;
  state.letters.clear();
  state.contacts = [];
  state.accounts = buildAccounts();
  state.sessionEmail = null;
  state.pendingLoginEmail = null;
  state.twofa = { totp_enabled: false, passkey_enabled: false, pendingTotpSecret: null };
  state.smtp = { ...DEFAULT_SMTP };
  state.resend = { ...DEFAULT_RESEND };
  state.resendTokens = {};
  state.setupEnabled = false;
  state.setupSwitchEnabled = true;
  state.registrationEnabled = true;
  state.dbUpgradeCalls = 0;
  state.setupExpectedSecret = MOCK_SETUP_SECRET;
}

/** 全新部署场景：无账号、有待完成的可视化初始化。 */
export function seedFreshDeployment(): void {
  resetMockStore();
  state.accounts = [];
  state.setupEnabled = true;
}

/** 手测用示例联系人（联调 mock 数据，交付汇报已明说）。 */
export function seedMockContacts(contacts: Array<{ id: string; name: string; email: string; notes?: string; tags?: string[] }>): void {
  state.contacts = contacts.map((c, i) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    notes: c.notes ?? "",
    tags: c.tags ?? [],
    created_at: `2026-10-24T0${i}:00:00.000Z`,
    updated_at: `2026-10-24T0${i}:00:00.000Z`,
  }));
}

export function toMeProfile(account: MockAccount): MeProfile {
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    is_active: account.is_active,
    approval_status: account.approval_status,
    display_name: account.display_name,
    timezone: account.timezone,
    language: account.language,
    created_at: account.created_at,
    twofa: {
      totp_enabled: state.twofa.totp_enabled,
      passkey_enabled: state.twofa.passkey_enabled,
      preferred_method: null,
    },
  };
}

export function toAdminUser(account: MockAccount): AdminUser {
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    is_active: account.is_active,
    approval_status: account.approval_status,
    display_name: account.display_name,
    timezone: account.timezone,
    language: account.language,
    created_at: account.created_at,
  };
}
