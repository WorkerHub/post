import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settingsApi, authApi } from "@/api/client";
import { resetMockStore, state } from "@/api/mock";
import type { MeProfile } from "@/api/settings";
import { RequireAuth } from "@/components/require-auth";
import { SessionBootstrap } from "@/components/session-bootstrap";
import { useAuthStore } from "@/store/auth";
import { useRegistrationStore } from "@/store/registration";

function user(): MeProfile {
  return {
    id: "u-test",
    email: "a@b.com",
    role: "user",
    is_active: true,
    approval_status: "approved",
    display_name: "小满",
    timezone: "Asia/Shanghai",
    language: "zh",
    created_at: "2026-10-24T00:00:00.000Z",
    twofa: { totp_enabled: false, passkey_enabled: false, preferred_method: null },
  };
}

function renderHarness() {
  return render(
    <MemoryRouter initialEntries={["/letters"]}>
      <SessionBootstrap />
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/letters" element={<div>工作台内容</div>} />
        </Route>
        <Route path="/login" element={<div>登录页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
  useRegistrationStore.setState({ enabled: null });
  // 冷启动初始态：鉴权未决
  useAuthStore.setState({ isAuthenticated: false, user: null, isLoading: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ isAuthenticated: false, user: null, isLoading: true });
  useRegistrationStore.setState({ enabled: null });
});

describe("鉴权初始化竞争（刷新/书签直达受保护路由）", () => {
  it("fetchMe 未决期展示加载态，异步返回后留在 /letters 不跳 /login", async () => {
    let resolveFetch: (u: MeProfile) => void = () => {};
    vi.spyOn(settingsApi, "fetchMe").mockImplementation(
      () =>
        new Promise<MeProfile>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    renderHarness();

    // 未决期：加载态，不得同步踢回 /login
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    expect(screen.queryByText("登录页")).not.toBeInTheDocument();

    // fetchMe 异步返回 → 放行，留在工作台
    resolveFetch(user());
    expect(await screen.findByText("工作台内容")).toBeInTheDocument();
    expect(screen.queryByText("登录页")).not.toBeInTheDocument();
  });

  it("fetchMe 失败：加载完成后跳 /login", async () => {
    vi.spyOn(settingsApi, "fetchMe").mockRejectedValue(new Error("401"));

    renderHarness();

    expect(await screen.findByText("登录页")).toBeInTheDocument();
  });
});

// 注册开关自举（ONE-336）：SessionBootstrap 读一次 GET /api/auth/registration-state 落 store，
// 注册页 / 登录页据此门控；读取失败保持 null（不误关门）。
describe("注册开关自举", () => {
  it("读到关闭：store.enabled=false（注册页与登录页随之隐藏注册入口）", async () => {
    vi.spyOn(settingsApi, "fetchMe").mockRejectedValue(new Error("401"));
    state.registrationEnabled = false;

    renderHarness();

    await waitFor(() => expect(useRegistrationStore.getState().enabled).toBe(false));
  });

  it("读到开启：store.enabled=true", async () => {
    vi.spyOn(settingsApi, "fetchMe").mockRejectedValue(new Error("401"));
    state.registrationEnabled = true;

    renderHarness();

    await waitFor(() => expect(useRegistrationStore.getState().enabled).toBe(true));
  });

  it("接口失败：保持 null，不把注册误判为关闭", async () => {
    vi.spyOn(settingsApi, "fetchMe").mockRejectedValue(new Error("401"));
    vi.spyOn(authApi, "getRegistrationState").mockRejectedValue(new Error("500"));

    renderHarness();

    expect(await screen.findByText("登录页")).toBeInTheDocument();
    expect(authApi.getRegistrationState).toHaveBeenCalled();
    expect(useRegistrationStore.getState().enabled).toBeNull();
  });
});
