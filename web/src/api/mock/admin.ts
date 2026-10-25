// 联调 mock：管理后台（SMTP 配置 + 测试邮件 + 用户批准/禁用/角色）。
import type { AdminApi, AdminUser, SmtpPatch, SmtpTestResult } from "../admin";
import { state, toAdminUser } from "./store";

export const mockAdminApi: AdminApi = {
  async getSmtp() {
    // 脱敏：只回显是否已配置，不返回明文（mock 里 password 本就为空/占位）
    return { ...state.smtp, password: state.smtp.password ? "••••••••" : "" };
  },
  async updateSmtp(patch: SmtpPatch) {
    state.smtp = {
      host: patch.host,
      port: patch.port,
      username: patch.username,
      // password 留空表示不改（脱敏，不覆盖已配置值）
      password: patch.password && patch.password.trim() !== "" ? patch.password : state.smtp.password,
      from: patch.from,
      from_name: patch.from_name,
    };
  },
  async testSmtp(to): Promise<SmtpTestResult> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      throw new Error("收件邮箱格式不正确");
    }
    if (!state.smtp.host) {
      return {
        success: false,
        message: "SMTP 服务器未配置：请先填写主机地址",
      };
    }
    return {
      success: true,
      message: `测试邮件已通过 ${state.smtp.host}:${state.smtp.port} 发出，请查收 ${to.trim()}`,
    };
  },
  async listUsers(): Promise<AdminUser[]> {
    return state.accounts.map(toAdminUser);
  },
  async approveUser(id) {
    const account = state.accounts.find((a) => a.id === id);
    if (!account) throw new Error("User not found");
    account.approval_status = "approved";
  },
  async updateUser(id, patch) {
    const account = state.accounts.find((a) => a.id === id);
    if (!account) throw new Error("User not found");
    if (patch.role !== undefined) account.role = patch.role;
    if (patch.is_active !== undefined) account.is_active = patch.is_active;
  },
};
