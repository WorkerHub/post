import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetMockStore, state } from "@/api/mock";
import type { MeProfile } from "@/api/settings";
import { useAuthStore } from "@/store/auth";
import SettingsPage from "./settings";

function baseUser(): MeProfile {
  return {
    id: "u-admin",
    email: "admin@example.com",
    role: "admin",
    is_active: true,
    approval_status: "approved",
    display_name: "管理员",
    timezone: "Asia/Shanghai",
    language: "zh",
    created_at: "2026-10-24T00:00:00.000Z",
    twofa: { totp_enabled: false, passkey_enabled: false, preferred_method: null },
  };
}

function memberUser(): MeProfile {
  return { ...baseUser(), id: "u-user", email: "user@example.com", role: "user", display_name: "" };
}

function renderSettings(user: MeProfile) {
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, user });
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

// 安全区 TOTP 开启对话框（ONE-335）：验证码输入框须为 text + one-time-code，
// 否则密码管理器会把 6 位验证码当作密码填进来。
describe("设置页 · 安全区 TOTP 验证码输入框", () => {
  it("开启 TOTP 对话框的验证码输入框为 text / one-time-code / numeric", async () => {
    state.sessionEmail = "admin@example.com";
    renderSettings(baseUser());
    await screen.findByText("TOTP 验证码");

    fireEvent.click(screen.getByRole("button", { name: "开启" }));

    const codeInput = await screen.findByLabelText("六位验证码");
    expect(codeInput).toHaveAttribute("type", "text");
    expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
    expect(codeInput).toHaveAttribute("inputmode", "numeric");
    expect(codeInput).toHaveAttribute("maxlength", "6");
  });
});

// F3 / ONE-331：设置页只保留个人资料 + 安全；SMTP/用户管理/系统维护已迁到 /admin。
describe("设置页 · 只有个人资料与安全", () => {
  it("普通用户：渲染个人资料与安全，无任何管理区块", async () => {
    renderSettings(memberUser());

    expect(await screen.findByText("个人资料")).toBeInTheDocument();
    expect(screen.getByText("安全")).toBeInTheDocument();

    expect(screen.queryByText("SMTP 配置")).not.toBeInTheDocument();
    expect(screen.queryByText("用户管理")).not.toBeInTheDocument();
    expect(screen.queryByText("系统维护")).not.toBeInTheDocument();
  });

  it("管理员：设置页同样只有两块，管理区块不再条件渲染在这里", async () => {
    renderSettings(baseUser());

    expect(await screen.findByText("个人资料")).toBeInTheDocument();
    expect(screen.getByText("安全")).toBeInTheDocument();

    expect(screen.queryByText("SMTP 配置")).not.toBeInTheDocument();
    expect(screen.queryByText("用户管理")).not.toBeInTheDocument();
    expect(screen.queryByText("系统维护")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /升级数据库/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("账户信息未就绪时展示加载提示，不渲染任何区块", () => {
    useAuthStore.setState({ isAuthenticated: true, isLoading: false, user: null });
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("正在加载账户信息…")).toBeInTheDocument();
    expect(screen.queryByText("个人资料")).not.toBeInTheDocument();
  });
});
