import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetMockStore, state } from "@/api/mock";
import type { MeProfile } from "@/api/settings";
import { useAuthStore } from "@/store/auth";
import SettingsPage from "./settings";

function adminUser(): MeProfile {
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

function renderSettings() {
  useAuthStore.setState({ isAuthenticated: true, user: adminUser() });
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

function rowOf(email: string): HTMLElement {
  const el = screen.getByText(email);
  const row = el.closest("div[class*='rounded']");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

beforeEach(() => {
  resetMockStore();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe("设置页 · 管理员 SMTP", () => {
  it("密码脱敏：已配置时不回显明文，提示留空不改", async () => {
    state.smtp.password = "secret123"; // 模拟已配置
    renderSettings();

    expect(await screen.findByText("SMTP 配置（全站一套）")).toBeInTheDocument();
    expect(screen.getByText(/密码已配置（脱敏，不回显明文）/)).toBeInTheDocument();
    // 密码输入框值应为空（不回显）
    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
  });

  it("发送测试邮件：填写邮箱后回显成功原文", async () => {
    renderSettings();
    await screen.findByText("SMTP 配置（全站一套）");

    fireEvent.change(screen.getByLabelText("测试收件邮箱"), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送测试邮件/ }));

    expect(await screen.findByText(/成功/)).toBeInTheDocument();
    expect(screen.getByText(/smtp\.example\.com/)).toBeInTheDocument();
  });
});

describe("设置页 · 管理员用户管理", () => {
  it("批准待批准账号：徽标消失", async () => {
    renderSettings();
    expect(await screen.findByText("用户管理")).toBeInTheDocument();
    expect(screen.getByText("pending@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    await waitFor(() => expect(screen.queryByText("待批准")).not.toBeInTheDocument());
  });

  it("禁用普通用户后徽标为「已禁用」，可再启用", async () => {
    renderSettings();
    await screen.findByText("用户管理");

    fireEvent.click(within(rowOf("user@example.com")).getByRole("button", { name: "禁用" }));
    await waitFor(() => expect(screen.getByText("已禁用")).toBeInTheDocument());

    fireEvent.click(within(rowOf("user@example.com")).getByRole("button", { name: "启用" }));
    await waitFor(() => expect(screen.queryByText("已禁用")).not.toBeInTheDocument());
  });
});
