import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupApi } from "@/api/client";
import { MOCK_SETUP_SECRET, resetMockStore, seedFreshDeployment, state } from "@/api/mock";
import { SetupError } from "@/api/setup";
import { useAuthStore } from "@/store/auth";
import { useSetupStore } from "@/store/setup";
import SetupPage from "./setup";

function renderSetup() {
  return render(
    <MemoryRouter initialEntries={["/setup"]}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/register" element={<div>注册占位</div>} />
        <Route path="/login" element={<div>登录占位</div>} />
        <Route path="/" element={<div>信墙占位</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
  localStorage.clear();
  useAuthStore.setState({ isAuthenticated: false, user: null, isLoading: false });
  useSetupStore.setState({ enabled: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useSetupStore.setState({ enabled: null });
});

describe("初始化页 · 未初始化（enabled=true）", () => {
  it("只展示一个密钥输入框，没有邮箱/密码字段", async () => {
    seedFreshDeployment();
    const { container } = renderSetup();

    expect(await screen.findByLabelText("初始化密钥")).toBeInTheDocument();
    // 唯一的输入框就是密钥（不收集邮箱/密码，账号由注册页创建）
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  });

  it("密钥错误 → 报错且本站仍待初始化", async () => {
    seedFreshDeployment();
    renderSetup();

    fireEvent.change(await screen.findByLabelText("初始化密钥"), {
      target: { value: "wrong-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /完成初始化/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("初始化密钥不正确");
    expect(state.setupEnabled).toBe(true);
  });

  it("密钥正确 → 初始化完成并引导去注册；密钥不落 localStorage", async () => {
    seedFreshDeployment();
    renderSetup();

    fireEvent.change(await screen.findByLabelText("初始化密钥"), {
      target: { value: MOCK_SETUP_SECRET },
    });
    fireEvent.click(screen.getByRole("button", { name: /完成初始化/ }));

    expect(await screen.findByText(/初始化已完成/)).toBeInTheDocument();
    expect(screen.queryByLabelText("初始化密钥")).not.toBeInTheDocument();
    expect(state.setupEnabled).toBe(false);
    expect(useSetupStore.getState().enabled).toBe(false);
    // 密钥只存在内存与请求体里：不经由浏览器存储留存
    expect(JSON.stringify(localStorage)).not.toContain(MOCK_SETUP_SECRET);

    fireEvent.click(screen.getByRole("link", { name: /去注册/ }));
    expect(await screen.findByText("注册占位")).toBeInTheDocument();
  });

  it("服务端未配置 SETUP_SECRET（500）→ 提示联系部署者", async () => {
    seedFreshDeployment();
    vi.spyOn(setupApi, "submit").mockRejectedValue(
      new SetupError("Server misconfigured", 500),
    );
    renderSetup();

    fireEvent.change(await screen.findByLabelText("初始化密钥"), {
      target: { value: "whatever" },
    });
    fireEvent.click(screen.getByRole("button", { name: /完成初始化/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("SETUP_SECRET");
    expect(alert).toHaveTextContent("部署者");
  });

  it("读取状态失败 → 可重试", async () => {
    seedFreshDeployment();
    vi.spyOn(setupApi, "fetchState").mockRejectedValueOnce(new Error("network down"));
    renderSetup();

    expect(await screen.findByText(/无法读取初始化状态/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByLabelText("初始化密钥")).toBeInTheDocument();
  });
});

describe("初始化页 · 已初始化（enabled=false）", () => {
  it("不再展示密钥输入框，提示已完成并给出去处", async () => {
    // 默认 mock 场景：已有账号、setup 已关闭
    renderSetup();

    expect(await screen.findByText(/本站已完成初始化/)).toBeInTheDocument();
    expect(screen.queryByLabelText("初始化密钥")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去登录" })).toBeInTheDocument();
  });

  it("以接口返回为准：store 里的旧状态不影响判断", async () => {
    // store 认为已初始化，但服务端仍待初始化 → 页面按接口结果展示表单
    seedFreshDeployment();
    useSetupStore.setState({ enabled: false });
    renderSetup();

    expect(await screen.findByLabelText("初始化密钥")).toBeInTheDocument();
    expect(useSetupStore.getState().enabled).toBe(true);
  });
});
