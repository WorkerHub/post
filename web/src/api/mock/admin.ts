// 联调 mock：管理后台（SMTP 配置 + 测试邮件 + 用户批准/禁用/角色 + 系统维护）。
import type {
  AdminApi,
  AdminUser,
  DbUpgradeResult,
  SetupSwitchState,
  SmtpPatch,
  SmtpTestResult,
} from "../admin";
import type { RegistrationState } from "../auth";
import { state, toAdminUser } from "./store";

/** 联调 mock 的 db-upgrade 执行摘要（真值由后端 ensureSchema 返回，此处仅形状示例）。 */
const MOCK_DB_UPGRADE_SUMMARY: DbUpgradeResult = {
  success: true,
  summary: [
    { label: "表前缀", value: "post_" },
    { label: "执行语句数", value: "72" },
  ],
  message: null,
};

export const mockAdminApi: AdminApi = {
  async getSmtp() {
    // 脱敏：永不下发明文密码，password 恒为空串，password_set 标记是否已配置
    return {
      ...state.smtp,
      password: "",
      password_set: Boolean(state.smtp.password),
    };
  },
  async updateSmtp(patch: SmtpPatch) {
    // password 留空表示不改（脱敏，不覆盖已配置值）
    const password =
      patch.password && patch.password.trim() !== "" ? patch.password : state.smtp.password;
    state.smtp = {
      host: patch.host,
      port: patch.port,
      username: patch.username,
      password,
      password_set: Boolean(password),
      from: patch.from,
      from_name: patch.from_name,
    };
  },
  async testSmtp(email): Promise<SmtpTestResult> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
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
      message: `测试邮件已通过 ${state.smtp.host}:${state.smtp.port} 发出，请查收 ${email.trim()}`,
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
  async dbUpgrade(): Promise<DbUpgradeResult> {
    state.dbUpgradeCalls += 1;
    // ensureSchema 幂等：重复调用不改结构，摘要照回
    return MOCK_DB_UPGRADE_SUMMARY;
  },
  async getSetupSwitch(): Promise<SetupSwitchState> {
    return { enabled: state.setupSwitchEnabled };
  },
  async updateSetupSwitch(enabled): Promise<SetupSwitchState> {
    state.setupSwitchEnabled = enabled;
    return { enabled: state.setupSwitchEnabled };
  },
  async getRegistration(): Promise<RegistrationState> {
    return { enabled: state.registrationEnabled };
  },
  async updateRegistration(enabled): Promise<RegistrationState> {
    state.registrationEnabled = enabled;
    return { enabled: state.registrationEnabled };
  },
};
