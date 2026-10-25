// 管理后台契约（ONE-176 冻结清单，与后端④ PR #10 对齐，不得私下变更）：
// - 用户管理：GET/POST /api/admin/users、GET/PATCH /api/admin/users/:id（PUT 兼容）、
//   PUT /api/admin/users/:id/approve；无 DELETE（删除不在前端暴露）。
// - SMTP 配置：GET/PUT /api/admin/settings/smtp、POST /api/admin/settings/smtp/test。
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

export interface AdminApi {
  getSmtp(): Promise<SmtpConfig>;
  updateSmtp(patch: SmtpPatch): Promise<void>;
  testSmtp(email: string): Promise<SmtpTestResult>;
  listUsers(): Promise<AdminUser[]>;
  approveUser(id: string): Promise<void>;
  /** 更新角色 / 禁用启用（PATCH，后端 PUT 兼容）。 */
  updateUser(id: string, patch: { role?: Role; is_active?: boolean }): Promise<void>;
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
};
