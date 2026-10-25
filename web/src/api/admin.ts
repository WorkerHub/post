// 管理后台契约（ONE-172/ONE-176）：
// - 用户管理复用 stage 2 已落地路由：GET /api/admin/users、GET/PUT/DELETE /api/admin/users/:uid、
//   PUT /api/admin/users/:uid/approve。
// - SMTP 配置为后端④路由：GET/PUT /api/admin/settings/smtp、POST /api/admin/settings/smtp/test。
// 注意：ONE-176 冻结清单写作 `GET/PATCH /api/admin/users/:id`，实际 stage 2 落地为
// `GET/PUT/DELETE /api/admin/users/:uid`，前端按已落地真实路由对接（见 ONE-177 交付评论说明）。
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

/** SMTP 配置：密码脱敏返回（非空串表示已配置，不返回明文）。 */
export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  /** 脱敏标记：后端只回显是否已配置，不返回明文；前端提交留空表示不改。 */
  password: string;
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

/** POST /api/admin/settings/smtp/test 结果：回显成功或错误原文。 */
export interface SmtpTestResult {
  success: boolean;
  message: string;
}

export interface AdminApi {
  getSmtp(): Promise<SmtpConfig>;
  updateSmtp(patch: SmtpPatch): Promise<void>;
  testSmtp(to: string): Promise<SmtpTestResult>;
  listUsers(): Promise<AdminUser[]>;
  approveUser(id: string): Promise<void>;
  /** 更新角色 / 禁用启用。 */
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
  async testSmtp(to) {
    const res = await fetch("/api/admin/settings/smtp/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      message?: string;
      error?: string;
    } | null;
    if (!res.ok) {
      throw new Error(body?.error || body?.message || `${res.status}`);
    }
    return {
      success: body?.success ?? true,
      message: body?.message ?? "已发送",
    };
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
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await parseError(res);
  },
};
