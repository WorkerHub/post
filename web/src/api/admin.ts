// 管理后台契约（ONE-176 冻结清单，与后端④ PR #10 对齐，不得私下变更）：
// - 用户管理：GET/POST /api/admin/users、GET/PATCH /api/admin/users/:id（PUT 兼容）、
//   PUT /api/admin/users/:id/approve；无 DELETE（删除不在前端暴露）。
// - SMTP 配置：GET/PUT /api/admin/settings/smtp、POST /api/admin/settings/smtp/test。
// - 系统维护（ONE-320，与后端⑤ ONE-319 冻结）：
//   POST /api/admin/db-upgrade → 200 {success:true, ...摘要}；不属于契约的键按摘要展示。
//   GET/POST /api/admin/setup-switch → {enabled:boolean}，POST body 只有 {enabled}。
//   开关 OFF 时 GET /api/setup/state 返回 404（见 api/setup.ts 与 pages/setup.tsx）。
// - 注册开关（ONE-336，消费 B1 / ONE-330 冻结契约，不得私改形状）：
//   GET/POST /api/admin/registration → {enabled:boolean}，POST body 只有 {enabled}；
//   默认开启，关闭后 POST /api/auth/register 一律 403（前端门控见 pages/register.tsx）。
import type { RegistrationState } from "./auth";
import type { Role } from "./settings";

/** GET /api/admin/users 返回的管理员视角用户（复用 publicUser 形状）。 */
export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  is_active: boolean;
  approval_status: string;
  display_name: string;
  timezone: string;
  language: string;
  created_at: string;
}

/** SMTP 配置：密码脱敏返回（password 恒为空串，password_set 标记是否已配置）。 */
export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  /** 脱敏：后端永不下发明文密码，恒为空串。 */
  password: string;
  /** 是否已配置密码（password 留空表示不改的依据）。 */
  password_set: boolean;
  from: string;
  from_name: string;
}

/** PUT /api/admin/settings/smtp 载荷：password 留空表示不改。 */
export interface SmtpPatch {
  host: string;
  port: number;
  username: string;
  password?: string;
  from: string;
  from_name: string;
}

/** POST /api/admin/settings/smtp/test 结果：成功或回显错误原文。 */
export interface SmtpTestResult {
  success: boolean;
  message: string;
}

/** Resend 发信渠道配置（管理员二选一）：token 脱敏返回（永不明文下发）。 */
export interface ResendConfig {
  /** 实际发信渠道：SMTP（默认，与现有行为零变化）或 Resend。 */
  channel: "smtp" | "resend";
  /** 发件身份（与 smtp_config 解耦，Resend 渠道独立）。 */
  from: string;
  from_name: string;
  /** 脱敏：{域名: ""}；域名对应 Resend 已验证的发信域。 */
  resend_tokens: Record<string, string>;
  /** {域名: 是否已配 token}。 */
  tokens_set: Record<string, boolean>;
}

/** PUT /api/admin/settings/resend 载荷：resend_tokens 某域名留空表示不改；缺失键表示删除该域名。 */
export interface ResendPatch {
  channel: "smtp" | "resend";
  /** 发件身份（可选，缺省不改）。 */
  from?: string;
  from_name?: string;
  resend_tokens?: Record<string, string>;
}

/** db-upgrade 摘要里的一条：键名按后端返回原样（契约只写「...摘要」，不假设键名）。 */
export interface DbUpgradeSummaryItem {
  label: string;
  value: string;
}

/** POST /api/admin/db-upgrade 结果：success 恒由后端给出，摘要按返回原样罗列。 */
export interface DbUpgradeResult {
  success: boolean;
  summary: DbUpgradeSummaryItem[];
  /** 后端若回 message 时的原文（可选字段）。 */
  message: string | null;
}

/** setup 页面开关状态：true = setup 页可用（默认 ON）。 */
export interface SetupSwitchState {
  enabled: boolean;
}

/** 已知摘要键的中文标签；未收录的键按后端原样展示（契约未冻结键名）。 */
const SUMMARY_LABELS: Record<string, string> = {
  table_prefix: "表前缀",
  statements: "执行语句数",
  executed: "执行语句数",
  applied: "变更数",
  duration_ms: "耗时（毫秒）",
};

/** 契约保留键，不当摘要展示。 */
const RESERVED_KEYS = new Set(["success", "message", "error"]);

function summarize(body: Record<string, unknown>): DbUpgradeSummaryItem[] {
  return Object.entries(body)
    .filter(([key, value]) => !RESERVED_KEYS.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => ({
      label: SUMMARY_LABELS[key] ?? key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
}

export interface AdminApi {
  getSmtp(): Promise<SmtpConfig>;
  updateSmtp(patch: SmtpPatch): Promise<void>;
  testSmtp(email: string): Promise<SmtpTestResult>;
  /** Resend 发信渠道：读取渠道 + {域名: token}（脱敏）。 */
  getResend(): Promise<ResendConfig>;
  updateResend(patch: ResendPatch): Promise<void>;
  testResend(email: string): Promise<SmtpTestResult>;
  listUsers(): Promise<AdminUser[]>;
  approveUser(id: string): Promise<void>;
  /** 更新角色 / 禁用启用（PATCH，后端 PUT 兼容）。 */
  updateUser(id: string, patch: { role?: Role; is_active?: boolean }): Promise<void>;
  /** 程序升级后免 SETUP_SECRET 就地升级数据库结构（幂等，可重复调用）。 */
  dbUpgrade(): Promise<DbUpgradeResult>;
  /** 读取 setup 页面开关。 */
  getSetupSwitch(): Promise<SetupSwitchState>;
  /** 写入 setup 页面开关；返回后端确认后的生效值。 */
  updateSetupSwitch(enabled: boolean): Promise<SetupSwitchState>;
  /** 读取注册开关（ONE-330 冻结契约，默认开启）。 */
  getRegistration(): Promise<RegistrationState>;
  /** 写入注册开关（body 只有 { enabled }），返回后端确认后的生效值。 */
  updateRegistration(enabled: boolean): Promise<RegistrationState>;
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

export const httpAdminApi: AdminApi = {
  async getSmtp() {
    const res = await fetch("/api/admin/settings/smtp");
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as SmtpConfig;
  },
  async updateSmtp(patch) {
    const res = await fetch("/api/admin/settings/smtp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await parseError(res);
  },
  async testSmtp(email) {
    const res = await fetch("/api/admin/settings/smtp/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
    } | null;
    if (!res.ok) {
      throw new Error(body?.error || `${res.status}`);
    }
    // 后端成功时只回 { success: true }（无 message）；失败时回 { success: false, error }。
    if (body?.success === false) {
      return { success: false, message: body.error ?? "SMTP error" };
    }
    return { success: true, message: "测试邮件已发送，请查收收件箱" };
  },
  async getResend() {
    const res = await fetch("/api/admin/settings/resend");
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as ResendConfig;
  },
  async updateResend(patch) {
    const res = await fetch("/api/admin/settings/resend", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await parseError(res);
  },
  async testResend(email) {
    const res = await fetch("/api/admin/settings/resend/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
    } | null;
    if (!res.ok) {
      throw new Error(body?.error || `${res.status}`);
    }
    if (body?.success === false) {
      return { success: false, message: body.error ?? "Resend error" };
    }
    return { success: true, message: "测试邮件已发送，请查收收件箱" };
  },
  async listUsers() {
    const res = await fetch("/api/admin/users");
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as AdminUser[];
  },
  async approveUser(id) {
    const res = await fetch(`/api/admin/users/${id}/approve`, { method: "PUT" });
    if (!res.ok) throw await parseError(res);
  },
  async updateUser(id, patch) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await parseError(res);
  },
  async dbUpgrade() {
    const res = await fetch("/api/admin/db-upgrade", { method: "POST" });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const message = typeof body?.error === "string" ? body.error : `${res.status}`;
      throw new Error(message);
    }
    return {
      // 只有显式 success:false 才算失败（后端成功态回 {success:true,...}）
      success: body?.success !== false,
      summary: summarize(body ?? {}),
      message: typeof body?.message === "string" ? body.message : null,
    };
  },
  async getSetupSwitch() {
    const res = await fetch("/api/admin/setup-switch");
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { enabled?: boolean };
    return { enabled: body.enabled === true };
  },
  async updateSetupSwitch(enabled) {
    const res = await fetch("/api/admin/setup-switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw await parseError(res);
    const body = (await res.json().catch(() => null)) as { enabled?: boolean } | null;
    // 契约 {success:true, enabled}；若后端漏回 enabled，以请求值为准，避免开关回弹到错值
    return { enabled: typeof body?.enabled === "boolean" ? body.enabled : enabled };
  },
  async getRegistration() {
    const res = await fetch("/api/admin/registration");
    if (!res.ok) throw await parseError(res);
    const body = (await res.json().catch(() => null)) as { enabled?: unknown } | null;
    // 后端默认开启：只有显式 false 才按关闭处理
    return { enabled: body?.enabled !== false };
  },
  async updateRegistration(enabled) {
    const res = await fetch("/api/admin/registration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw await parseError(res);
    const body = (await res.json().catch(() => null)) as { enabled?: boolean } | null;
    // 契约 {success:true, enabled}；若后端漏回 enabled，以请求值为准，避免开关回弹到错值
    return { enabled: typeof body?.enabled === "boolean" ? body.enabled : enabled };
  },
};
