import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/api/client";
import { resetMockStore, state } from "@/api/mock";
import type { MeProfile } from "@/api/settings";
import { useAuthStore } from "@/store/auth";
import { useRegistrationStore } from "@/store/registration";
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
  useRegistrationStore.setState({ enabled: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ isAuthenticated: false, user: null });
  useRegistrationStore.setState({ enabled: null });
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

// 注册开关区（ONE-336）：读 GET /api/admin/registration（默认开启），切换即 POST { enabled }。
describe("系统管理页 · 注册开关", () => {
  it("区块标题为「注册开关」，默认展示后端真实值：已允许注册", async () => {
    renderAdmin();

    expect(await screen.findByText("注册开关")).toBeInTheDocument();
    const toggle = await screen.findByRole("switch", { name: "注册开关" });
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByText("已允许注册")).toBeInTheDocument();
    // 与系统维护的 setup 开关是两个独立控件
    expect(screen.getByRole("switch", { name: "setup 页面开关" })).toBeInTheDocument();
  });

  it("关闭：落库为 false、同步全局注册状态、给出提示；再开启恢复", async () => {
    renderAdmin();
    const toggle = await screen.findByRole("switch", { name: "注册开关" });
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);

    await waitFor(() => expect(state.registrationEnabled).toBe(false));
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("已关闭注册")).toBeInTheDocument();
    expect(screen.getByText(/注册已关闭：直接访问 \/register 显示/)).toBeInTheDocument();
    // 登录页 / 注册页读的就是这个全局状态
    expect(useRegistrationStore.getState().enabled).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => expect(state.registrationEnabled).toBe(true));
    expect(toggle).toBeChecked();
    expect(screen.getByText(/注册已开启/)).toBeInTheDocument();
    expect(useRegistrationStore.getState().enabled).toBe(true);
  });

  it("读取失败：展示错误原文，开关不可操作（不猜测成开或关）", async () => {
    vi.spyOn(adminApi, "getRegistration").mockRejectedValueOnce(new Error("Forbidden"));
    renderAdmin();

    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
    expect(screen.getByRole("switch", { name: "注册开关" })).toBeDisabled();
    // 不猜测成开或关，如实显示读取失败
    expect(screen.getByText("读取失败")).toBeInTheDocument();
    expect(screen.queryByText("已允许注册")).not.toBeInTheDocument();
    expect(screen.queryByText("已关闭注册")).not.toBeInTheDocument();
  });

  it("写入失败：开关不误翻、展示错误原文、后端值不变", async () => {
    vi.spyOn(adminApi, "updateRegistration").mockRejectedValueOnce(new Error("Internal error"));
    renderAdmin();
    const toggle = await screen.findByRole("switch", { name: "注册开关" });
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("Internal error");
    expect(toggle).toBeChecked();
    expect(state.registrationEnabled).toBe(true);
    expect(useRegistrationStore.getState().enabled).toBe(true);
  });
});

// ONE-370：SMTP 区块专属 form；密码框 autoComplete 定死 off（非 current-password / new-password），
// name="smtp_password"；用户名同步 off；测试邮件独立 form，不与密码框同 form。
describe("系统管理页 · SMTP 表单语义（ONE-370）", () => {
  it("SMTP 密码框：off / smtp_password，且在专属 form 内独此一个密码框", async () => {
    renderAdmin();
    await screen.findByText("SMTP 配置");

    const passwordInput = screen.getByLabelText("密码");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(passwordInput).toHaveAttribute("name", "smtp_password");
    expect(passwordInput).toHaveAttribute("autocomplete", "off");
    expect(passwordInput.getAttribute("autocomplete")).not.toBe("current-password");
    expect(passwordInput.getAttribute("autocomplete")).not.toBe("new-password");

    const form = passwordInput.closest("form");
    expect(form).toHaveAttribute("name", "smtp-config");
    expect(form!.querySelectorAll('input[type="password"]').length).toBe(1);
    expect(form!.querySelector('input[autocomplete="one-time-code"]')).toBeNull();
    expect(screen.getByRole("button", { name: /保存配置/ })).toHaveAttribute("type", "submit");
  });

  it("SMTP 其余字段带 name 与 off；测试邮件在独立 form 内且不含密码框", async () => {
    const { container } = renderAdmin();
    await screen.findByText("SMTP 配置");

    const usernameInput = screen.getByLabelText("用户名");
    expect(usernameInput).toHaveAttribute("name", "smtp_username");
    expect(usernameInput).toHaveAttribute("autocomplete", "off");

    expect(screen.getByLabelText("服务器地址")).toHaveAttribute("name", "smtp_host");
    expect(screen.getByLabelText("端口")).toHaveAttribute("name", "smtp_port");
    expect(screen.getByLabelText("发件邮箱")).toHaveAttribute("name", "smtp_from");
    expect(screen.getByLabelText("发件人名称")).toHaveAttribute("name", "smtp_from_name");

    const testForm = container.querySelector('form[name="smtp-test"]');
    expect(testForm).not.toBeNull();
    expect(testForm!.contains(screen.getByLabelText("测试收件邮箱"))).toBe(true);
    expect(testForm!.querySelector('input[type="password"]')).toBeNull();
  });
});

describe("系统管理页 · Resend 发信渠道", () => {
  it("默认 SMTP；切到 Resend 填域名 token 保存后落库且 token 脱敏回显", async () => {
    renderAdmin();
    await screen.findByText("Resend 发信渠道");

    const smtpRadio = screen.getByRole("radio", { name: /现有通道/ });
    const resendRadio = screen.getByRole("radio", { name: /API 直连/ });
    expect(smtpRadio).toBeChecked();
    expect(resendRadio).not.toBeChecked();

    // 切到 Resend + 新增一个域名 token 并保存
    fireEvent.click(resendRadio);
    fireEvent.click(screen.getByRole("button", { name: "添加域名" }));
    fireEvent.change(screen.getByLabelText("发信域名"), {
      target: { value: "example.com" },
    });
    fireEvent.change(screen.getByLabelText("Resend API key"), {
      target: { value: "re_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存 Resend 配置/ }));

    await waitFor(() => expect(state.resend.channel).toBe("resend"));
    expect(state.resendTokens["example.com"]).toBe("re_token");
    // 保存后重新加载，token 明文不回显（脱敏）
    expect(screen.queryByDisplayValue("re_token")).not.toBeInTheDocument();
  });

  it("发件身份独立保存：填 Resend 发件邮箱/名称后保存落库并回显", async () => {
    renderAdmin();
    await screen.findByText("Resend 发信渠道");

    fireEvent.change(screen.getByLabelText("Resend 发件邮箱"), {
      target: { value: "notify@someday.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Resend 发件人名称"), {
      target: { value: "时光邮局" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存 Resend 配置/ }));

    await waitFor(() => expect(state.resend.from).toBe("notify@someday.example.com"));
    expect(state.resend.from_name).toBe("时光邮局");
  });

  it("删除域名：点删除后保存，该域名从配置中移除", async () => {
    renderAdmin();
    await screen.findByText("Resend 发信渠道");
    fireEvent.click(screen.getByRole("radio", { name: /API 直连/ }));

    fireEvent.click(screen.getByRole("button", { name: "添加域名" }));
    fireEvent.click(screen.getByRole("button", { name: "添加域名" }));
    const domains = screen.getAllByLabelText("发信域名");
    const keys = screen.getAllByLabelText("Resend API key");
    fireEvent.change(domains[0], { target: { value: "a.com" } });
    fireEvent.change(keys[0], { target: { value: "ta" } });
    fireEvent.change(domains[1], { target: { value: "b.com" } });
    fireEvent.change(keys[1], { target: { value: "tb" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Resend 配置/ }));

    await waitFor(() => expect(state.resendTokens["a.com"]).toBe("ta"));
    expect(state.resendTokens["b.com"]).toBe("tb");

    // 重新加载后删掉第一个域名再保存
    const deleteButtons = await screen.findAllByRole("button", { name: "删除该域名" });
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: /保存 Resend 配置/ }));

    await waitFor(() => expect(state.resendTokens["a.com"]).toBeUndefined());
    expect(state.resendTokens["b.com"]).toBe("tb");
  });
});
