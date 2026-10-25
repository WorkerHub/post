// 联调 mock：初始化（setup）状态与密钥校验的内存等价物。
// 仅在 vitest（MODE === "test"）下生效，生产构建走真实 HTTP 接口（见 api/client.ts）。
import { SetupError, type SetupApi } from "../setup";
import { state } from "./store";

export const mockSetupApi: SetupApi = {
  async fetchState() {
    // 开关 OFF：后端对 GET /api/setup/state 直接 404，不吐任何状态信息
    if (!state.setupSwitchEnabled) throw new SetupError("Not found", 404);
    return { enabled: state.setupEnabled };
  },
  async submit(secret) {
    // 契约顺序同后端：先比对密钥，再判断是否已关闭。
    if (!secret) throw new SetupError("Setup secret required", 400);
    if (secret !== state.setupExpectedSecret) {
      throw new SetupError("Invalid setup secret", 403);
    }
    if (!state.setupEnabled) throw new SetupError("Setup is closed", 403);
    // 只落开关，不创建账号（首个注册用户才是管理员，见 mockAuthApi.register）
    state.setupEnabled = false;
  },
};
