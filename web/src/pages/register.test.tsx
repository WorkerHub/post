import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetMockStore, state } from "@/api/mock";
import { useAuthStore } from "@/store/auth";
import { useRegistrationStore } from "@/store/registration";
import { useSetupStore } from "@/store/setup";
import RegisterPage from "./register";

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

// ONE-336 冻结文案：关闭后注册页只展示「注册已关闭，暂不接受新用户注册」，不渲染表单。
describe("注册页 · 注册开关门控（ONE-336）", () => {
  it("注册关闭：显示已关闭文案，不渲染表单，可回登录页", () => {
    useRegistrationStore.setState({ enabled: false });
    renderRegister();

    expect(screen.getByText("注册已关闭，暂不接受新用户注册")).toBeInTheDocument();
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("确认密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "注册" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute("href", "/login");
  });

  it("注册开启：正常渲染注册表单", () => {
    useRegistrationStore.setState({ enabled: true });
    renderRegister();

    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "注册" })).toBeInTheDocument();
    expect(screen.queryByText("注册已关闭，暂不接受新用户注册")).not.toBeInTheDocument();
  });

  it("状态未取得（null：自举中或接口失败）：不误关门，仍渲染表单", () => {
    renderRegister();

    expect(useRegistrationStore.getState().enabled).toBeNull();
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.queryByText("注册已关闭，暂不接受新用户注册")).not.toBeInTheDocument();
  });

  it("管理员重新开启后：表单恢复，无需刷新页面", () => {
    useRegistrationStore.setState({ enabled: false });
    renderRegister();
    expect(screen.getByText("注册已关闭，暂不接受新用户注册")).toBeInTheDocument();

    act(() => useRegistrationStore.setState({ enabled: true }));

    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.queryByText("注册已关闭，暂不接受新用户注册")).not.toBeInTheDocument();
  });

  // 状态过期（页面仍显示表单、后端已关闭）：注册接口 403 才是最终裁决，不伪造成功。
  it("状态过期时提交：原样展示后端 403 错误，不提示注册成功", async () => {
    useRegistrationStore.setState({ enabled: true });
    state.registrationEnabled = false;
    renderRegister();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "name+tag@example.co.uk" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "newpass123" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Registration is disabled");
    expect(screen.queryByText(/注册成功/)).not.toBeInTheDocument();
    // 未落账号
    expect(state.accounts.some((a) => a.email === "name+tag@example.co.uk")).toBe(false);
  });
});

// ONE-370：注册表单独立成 <form>，三个凭证字段补齐 name（§5B 第二信号）。
describe("注册页 · 表单结构与字段语义（ONE-370）", () => {
  it("注册表单：独立 form + 三个字段 name/autocomplete + submit 按钮", () => {
    const { container } = renderRegister();

    const form = container.querySelector('form[name="register"]');
    expect(form).not.toBeNull();

    const emailInput = screen.getByLabelText("邮箱");
    expect(emailInput).toHaveAttribute("name", "email");
    expect(emailInput).toHaveAttribute("type", "email");
    expect(emailInput).toHaveAttribute("autocomplete", "email");

    const passwordInput = screen.getByLabelText("密码");
    expect(passwordInput).toHaveAttribute("name", "password");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(passwordInput).toHaveAttribute("autocomplete", "new-password");

    const confirmInput = screen.getByLabelText("确认密码");
    expect(confirmInput).toHaveAttribute("name", "confirm-password");
    expect(confirmInput).toHaveAttribute("autocomplete", "new-password");

    for (const input of [emailInput, passwordInput, confirmInput]) {
      expect(form!.contains(input)).toBe(true);
    }
    expect(form!.querySelector('input[autocomplete="one-time-code"]')).toBeNull();
    expect(screen.getByRole("button", { name: "注册" })).toHaveAttribute("type", "submit");
  });

  it("原生 form 提交被 onSubmit 接住：注册成功提示出现，页面不刷新", async () => {
    const { container } = renderRegister();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "name+tag@example.co.uk" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "newpass123" } });
    fireEvent.submit(container.querySelector('form[name="register"]')!);

    expect(await screen.findByText(/等待管理员批准/)).toBeInTheDocument();
  });
});
