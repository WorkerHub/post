// 初始化（setup）契约，ONE-314 与后端 ONE-313 冻结：
// - GET  /api/setup/state → { enabled: boolean }（是否仍需初始化）
// - POST /api/setup       body { setup_secret: string } → 200 { success: true }
//                          403 密钥不符 / 500 服务端未配置有效的 SETUP_SECRET
//
// 安全口径：SETUP_SECRET 只出现在用户输入与请求体里——不进 URL、不进日志、
// 不进 localStorage、失败后立即从组件状态里清空、成功态不回显。

/** setup 状态：`enabled=true` 表示本站尚未初始化（首个账号还不存在）。 */
export interface SetupState {
  enabled: boolean;
}

/** 携带 HTTP 状态码的错误，供页面按 403/500 给出不同文案。 */
export class SetupError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SetupError";
    this.status = status;
  }
}

export interface SetupApi {
  fetchState(): Promise<SetupState>;
  /** 仅提交初始化密钥；不创建账号（首个注册用户才成为管理员）。 */
  submit(secret: string): Promise<void>;
}

async function parseError(res: Response): Promise<SetupError> {
  let message = `${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // 非 JSON 错误体，忽略
  }
  return new SetupError(message, res.status);
}

export const httpSetupApi: SetupApi = {
  async fetchState() {
    const res = await fetch("/api/setup/state");
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { enabled?: boolean };
    return { enabled: body.enabled === true };
  },
  async submit(secret) {
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setup_secret: secret }),
    });
    if (!res.ok) throw await parseError(res);
  },
};
