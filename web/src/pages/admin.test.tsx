import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/api/client";
import { resetMockStore, state } from "@/api/mock";
import type { MeProfile } from "@/api/settings";
import { useAuthStore } from "@/store/auth";
import AdminPage from "./admin";

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

function renderAdmin() {
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, user: adminUser() });
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <AdminPage />
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
  vi.restoreAllMocks();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe("系统管理页 · 三块齐备", () => {
  it("同时渲染 SMTP 配置、用户管理、系统维护", async () => {
    renderAdmin();

    expect(await screen.findByText("系统管理")).toBeInTheDocument();
    expect(await screen.findByText("SMTP 配置")).toBeInTheDocument();
    expect(await screen.findByText("用户管理")).toBeInTheDocument();
    expect(await screen.findByText("系统维护")).toBeInTheDocument();
  });

  it("SMTP 区块不再出现「全站一套」文案", async () => {
    renderAdmin();

    await screen.findByText("SMTP 配置");
    expect(screen.queryByText(/全站一套/)).not.toBeInTheDocument();
  });
});

describe("系统管理页 · SMTP", () => {
  it("密码脱敏：已配置时不回显明文，提示留空不改", async () => {
    state.smtp.password = "secret123"; // 模拟已配置
    renderAdmin();

    expect(await screen.findByText("SMTP 配置")).toBeInTheDocument();
    expect(screen.getByText(/密码已配置（脱敏，不回显明文）/)).toBeInTheDocument();
    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
  });

  it("发送测试邮件：填写邮箱后回显成功原文", async () => {
    renderAdmin();
    await screen.findByText("SMTP 配置");

    fireEvent.change(screen.getByLabelText("测试收件邮箱"), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送测试邮件/ }));

    expect(await screen.findByText(/成功/)).toBeInTheDocument();
    expect(screen.getByText(/smtp\.example\.com/)).toBeInTheDocument();
  });
});

describe("系统管理页 · 用户管理", () => {
  it("批准待批准账号：徽标消失", async () => {
    renderAdmin();
    expect(await screen.findByText("用户管理")).toBeInTheDocument();
    expect(screen.getByText("pending@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    await waitFor(() => expect(screen.queryByText("待批准")).not.toBeInTheDocument());
  });

  it("禁用普通用户后徽标为「已禁用」，可再启用", async () => {
    renderAdmin();
    await screen.findByText("用户管理");

    fireEvent.click(within(rowOf("user@example.com")).getByRole("button", { name: "禁用" }));
    await waitFor(() => expect(screen.getByText("已禁用")).toBeInTheDocument());

    fireEvent.click(within(rowOf("user@example.com")).getByRole("button", { name: "启用" }));
    await waitFor(() => expect(screen.queryByText("已禁用")).not.toBeInTheDocument());
  });
});

// 系统维护区（ONE-320）：升级数据库按钮 + setup 页面开关，现随 /admin 一并迁移。
describe("系统管理页 · 系统维护", () => {
  it("升级数据库：确认后调用接口、回显成功与执行摘要", async () => {
    renderAdmin();
    expect(await screen.findByText("系统维护")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /升级数据库/ }));
    expect(state.dbUpgradeCalls).toBe(0);
    fireEvent.click(await screen.findByRole("button", { name: "开始升级" }));

    expect(await screen.findByText("数据库升级完成")).toBeInTheDocument();
    expect(state.dbUpgradeCalls).toBe(1);

    const status = screen.getByRole("status");
    expect(within(status).getByText("成功：")).toBeInTheDocument();
    expect(within(status).getByText("表前缀")).toBeInTheDocument();
    expect(within(status).getByText("post_")).toBeInTheDocument();
  });

  it("升级失败：原样展示后端错误，仍可再次点击", async () => {
    vi.spyOn(adminApi, "dbUpgrade").mockRejectedValueOnce(
      new Error("D1_ERROR: no such table: users"),
    );
    renderAdmin();
    await screen.findByText("系统维护");

    fireEvent.click(screen.getByRole("button", { name: /升级数据库/ }));
    fireEvent.click(await screen.findByRole("button", { name: "开始升级" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("D1_ERROR: no such table: users");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /升级数据库/ })).toBeEnabled();
  });

  it("setup 开关：初始为开启，关闭提示 /setup 呈现 404 并落盘，再开启恢复", async () => {
    renderAdmin();
    await screen.findByText("系统维护");

    const toggle = await screen.findByRole("switch", { name: "setup 页面开关" });
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByText("已开启")).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(state.setupSwitchEnabled).toBe(false));
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("已关闭")).toBeInTheDocument();
    expect(screen.getByText(/浏览器访问 \/setup 现在呈现 404/)).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(state.setupSwitchEnabled).toBe(true));
    expect(toggle).toBeChecked();
    expect(screen.getByText(/setup 页面已开启/)).toBeInTheDocument();
  });

  it("setup 开关写入失败：开关不误翻、展示错误原文", async () => {
    vi.spyOn(adminApi, "updateSetupSwitch").mockRejectedValueOnce(new Error("Forbidden"));
    renderAdmin();
    await screen.findByText("系统维护");

    const toggle = await screen.findByRole("switch", { name: "setup 页面开关" });
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
    expect(toggle).toBeChecked();
    expect(state.setupSwitchEnabled).toBe(true);
  });
});
