import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetMockStore, state } from "@/api/mock";
import { useAuthStore } from "@/store/auth";
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
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null });
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
