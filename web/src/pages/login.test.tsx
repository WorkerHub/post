import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupApi } from "@/api/client";
import { MOCK_SETUP_SECRET, resetMockStore, seedFreshDeployment, state } from "@/api/mock";
import { useAuthStore } from "@/store/auth";
import { useSetupStore } from "@/store/setup";
import LoginPage from "./login";
import RegisterPage from "./register";

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
});

afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null });
  useSetupStore.setState({ enabled: null });
});

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

    fireEvent.change(screen.getByLabelText("六位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /验证/ }));

    expect(await screen.findByText("工作台占位")).toBeInTheDocument();
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
