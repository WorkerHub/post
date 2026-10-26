import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authApi, settingsApi, setupApi } from "@/api/client";
import { MOCK_SETUP_SECRET, resetMockStore, seedFreshDeployment, state } from "@/api/mock";
import { toMeProfile } from "@/api/mock/store";
import type { MeProfile } from "@/api/settings";
import { useAuthStore } from "@/store/auth";
import { useRegistrationStore } from "@/store/registration";
import { useSetupStore } from "@/store/setup";
import LoginPage from "./login";
import RegisterPage from "./register";
import SettingsPage from "./settings";

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/letters" element={<div>工作台占位</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderRegister() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/login" element={<div>登录占位</div>} />
        <Route path="/setup" element={<div>初始化占位</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
  useAuthStore.setState({ isAuthenticated: false, user: null });
  useSetupStore.setState({ enabled: null });
  useRegistrationStore.setState({ enabled: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ isAuthenticated: false, user: null });
  useSetupStore.setState({ enabled: null });
  useRegistrationStore.setState({ enabled: null });
});

/**
 * 真实后端 POST /api/auth/login、/api/auth/2fa/verify、passkey verify 返回的是 publicUser
 * （worker/src/routes/auth.ts），不含 twofa——这正是 ONE-332「登录后设置页空白」的根因。
 * 联调 mock 一直回完整档案，所以这里显式模拟真实形状。
 */
function backendLoginUser(email: string): MeProfile {
  const account = state.accounts.find((a) => a.email === email)!;
  const { twofa: _twofa, ...rest } = toMeProfile(account);
  return rest as MeProfile;
}

function renderLoginWithSettings() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/letters" element={<div>工作台占位</div>} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("登录页 · 密码登录", () => {
  it("管理员密码正确 → 登录成功进入工作台", async () => {
    const adminPw = state.accounts.find((a) => a.email === "admin@example.com")!.password;
    renderLogin();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: adminPw } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("工作台占位")).toBeInTheDocument();
  });

  it("密码错误 → 报错留在登录页", async () => {
    renderLogin();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
  });
});

describe("登录页 · TOTP 二次验证", () => {
  it("开启 TOTP 的账号登录需输入六位验证码", async () => {
    state.twofa.totp_enabled = true;
    const adminPw = state.accounts.find((a) => a.email === "admin@example.com")!.password;
    renderLogin();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: adminPw } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    // 进入二次验证步骤
    expect(await screen.findByText(/双重验证/)).toBeInTheDocument();

    const codeInput = screen.getByLabelText("六位验证码");
    // ONE-335：显式 text + one-time-code，避免 Bitwarden 等密码管理器误填密码
    expect(codeInput).toHaveAttribute("type", "text");
    expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
    expect(codeInput).toHaveAttribute("inputmode", "numeric");

    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /验证/ }));

    expect(await screen.findByText("工作台占位")).toBeInTheDocument();
  });
});

describe("登录后档案补齐（ONE-332）", () => {
  it("无 2FA 登录：登录响应只含公开档案 → store 拿到含 twofa 的完整档案，设置页直接有内容", async () => {
    // 模拟真实后端：登录成功即签发会话 Cookie，但响应体只有 publicUser（无 twofa）
    vi.spyOn(authApi, "login").mockImplementationOnce(async (email) => {
      state.sessionEmail = email.trim().toLowerCase();
      return { requires2fa: false, user: backendLoginUser(email.trim().toLowerCase()) };
    });

    renderLoginWithSettings();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: {
        value: state.accounts.find((a) => a.email === "user@example.com")!.password,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("工作台占位")).toBeInTheDocument();

    const stored = useAuthStore.getState().user!;
    expect(stored.email).toBe("user@example.com");
    expect(stored.twofa).toEqual({
      totp_enabled: false,
      passkey_enabled: false,
      preferred_method: null,
    });

    // 修复前 user.twofa 为 undefined，设置页读 user.twofa.totp_enabled 直接抛错空白
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("安全")).toBeInTheDocument();
    expect(screen.getByText("TOTP 验证码")).toBeInTheDocument();
  });

  it("已开 TOTP 的账号：2FA 验证成功后 store 里是含真实 twofa 状态的完整档案", async () => {
    state.twofa.totp_enabled = true;
    vi.spyOn(authApi, "verify2fa").mockImplementationOnce(async () => {
      state.sessionEmail = "admin@example.com";
      return backendLoginUser("admin@example.com");
    });

    renderLoginWithSettings();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: state.accounts.find((a) => a.email === "admin@example.com")!.password },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText(/双重验证/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("六位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /验证/ }));

    expect(await screen.findByText("工作台占位")).toBeInTheDocument();
    expect(useAuthStore.getState().user!.twofa).toEqual({
      totp_enabled: true,
      passkey_enabled: false,
      preferred_method: null,
    });
  });

  it("档案读取失败 → 报错留在登录页，不把缺 twofa 的半残档案写进 store", async () => {
    vi.spyOn(settingsApi, "getSettings").mockRejectedValueOnce(new Error("500"));

    renderLoginWithSettings();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: {
        value: state.accounts.find((a) => a.email === "user@example.com")!.password,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("读取账户信息失败");
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(screen.queryByText("工作台占位")).not.toBeInTheDocument();
  });
});

describe("注册页", () => {
  it("注册成功提示待管理员批准", async () => {
    renderRegister();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "name+tag@example.co.uk" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "newpass123" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(await screen.findByText(/等待管理员批准/)).toBeInTheDocument();
  });

  it("两次密码不一致时报错", async () => {
    renderRegister();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "name+tag@example.co.uk" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "different" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("不一致");
  });
});

describe("注册页 · setup 未初始化", () => {
  it("注册页引导到 /setup，不渲染注册表单", () => {
    useSetupStore.setState({ enabled: true });
    renderRegister();

    expect(screen.getByText("初始化占位")).toBeInTheDocument();
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
  });

  it("登录页同样引导到 /setup", () => {
    useSetupStore.setState({ enabled: true });
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<div>初始化占位</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("初始化占位")).toBeInTheDocument();
  });
});

describe("注册页 · 首个账号成为管理员（ONE-314）", () => {
  it("初始化完成后首个注册账号 → 提示「已成为本站管理员」", async () => {
    seedFreshDeployment();
    // 走真实的初始化接口：只关开关，不建账号
    await setupApi.submit(MOCK_SETUP_SECRET);
    renderRegister();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "first@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "firstpass123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "firstpass123" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(await screen.findByText(/已成为本站管理员/)).toBeInTheDocument();
    expect(screen.queryByText(/等待管理员批准/)).not.toBeInTheDocument();
    // 注册不签发会话：首账号也要去登录页拿 Cookie
    expect(screen.getByRole("link", { name: "去登录" })).toBeInTheDocument();
    expect(state.accounts[0]).toMatchObject({
      email: "first@example.com",
      role: "admin",
      approval_status: "approved",
    });
  });

  it("第二个注册账号 → 维持「等待管理员批准」", async () => {
    seedFreshDeployment();
    await setupApi.submit(MOCK_SETUP_SECRET);

    const first = renderRegister();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "first@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "firstpass123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "firstpass123" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    expect(await screen.findByText(/已成为本站管理员/)).toBeInTheDocument();
    first.unmount();

    renderRegister();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "second@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secondpass123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "secondpass123" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(await screen.findByText(/等待管理员批准/)).toBeInTheDocument();
    expect(state.accounts[1]).toMatchObject({
      email: "second@example.com",
      role: "user",
      approval_status: "pending",
    });
  });
});

// 登录页注册入口门控（ONE-336）：注册关闭时隐藏「注册」入口，开启 / 状态未知时保留。
describe("登录页 · 注册入口门控（ONE-336）", () => {
  it("注册开启：显示「注册」入口", () => {
    useRegistrationStore.setState({ enabled: true });
    renderLogin();

    expect(screen.getByRole("link", { name: "注册" })).toHaveAttribute("href", "/register");
  });

  it("状态未取得（null）：不误隐藏入口", () => {
    renderLogin();

    expect(useRegistrationStore.getState().enabled).toBeNull();
    expect(screen.getByRole("link", { name: "注册" })).toBeInTheDocument();
  });

  it("注册关闭：隐藏「注册」入口，登录表单照常可用", () => {
    useRegistrationStore.setState({ enabled: false });
    renderLogin();

    expect(screen.queryByRole("link", { name: "注册" })).not.toBeInTheDocument();
    expect(screen.queryByText(/还没有账号/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });
});

// ONE-370：§5B 全信号集落地——凭据步骤与二次验证步骤各自独立 <form>，
// 凭证字段补齐 name（第二信号），验证码框 id 去掉 login 词根（消除 username 弱匹配歧义）。
describe("登录页 · 表单结构与字段语义（ONE-370）", () => {
  it("凭据步骤：独立 form + 邮箱/密码带 name，提交按钮为 submit", () => {
    const { container } = renderLogin();

    const form = container.querySelector('form[name="login-credentials"]');
    expect(form).not.toBeNull();

    const emailInput = screen.getByLabelText("邮箱");
    expect(emailInput).toHaveAttribute("name", "email");
    expect(emailInput).toHaveAttribute("type", "email");
    expect(emailInput).toHaveAttribute("autocomplete", "email");
    expect(form!.contains(emailInput)).toBe(true);

    const passwordInput = screen.getByLabelText("密码");
    expect(passwordInput).toHaveAttribute("name", "password");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(passwordInput).toHaveAttribute("autocomplete", "current-password");
    expect(form!.contains(passwordInput)).toBe(true);

    // 密码框与验证码框不共 form：凭据步骤的 form 内没有 one-time-code 字段
    expect(form!.querySelector('input[autocomplete="one-time-code"]')).toBeNull();
    expect(screen.getByRole("button", { name: "登录" })).toHaveAttribute("type", "submit");
  });

  it("凭据步骤：原生 form 提交被 onSubmit 接住，不刷新页面即完成登录", async () => {
    const adminPw = state.accounts.find((a) => a.email === "admin@example.com")!.password;
    const { container } = renderLogin();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: adminPw } });
    fireEvent.submit(container.querySelector('form[name="login-credentials"]')!);

    expect(await screen.findByText("工作台占位")).toBeInTheDocument();
  });

  it("二次验证步骤：验证码框 id/name 统一 otp-code，所在 form 内无密码框", async () => {
    state.twofa.totp_enabled = true;
    const adminPw = state.accounts.find((a) => a.email === "admin@example.com")!.password;
    renderLogin();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: adminPw } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    const codeInput = await screen.findByLabelText("六位验证码");
    expect(codeInput).toHaveAttribute("id", "otp-code");
    expect(codeInput).toHaveAttribute("name", "otp-code");
    // id 不再含 login 词根（Bitwarden AmbiguousUsernameFieldNames 的弱 username 歧义来源）
    expect(codeInput.getAttribute("id")).not.toContain("login");
    // 属性集维持 ONE-335 后的合规态：本轮不叠加、不改动
    expect(codeInput).toHaveAttribute("type", "text");
    expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
    expect(codeInput).toHaveAttribute("inputmode", "numeric");
    expect(codeInput).toHaveAttribute("maxlength", "6");

    const form = codeInput.closest("form");
    expect(form).toHaveAttribute("name", "login-twofa");
    expect(form!.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByRole("button", { name: /验证/ })).toHaveAttribute("type", "submit");
  });
});
