import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetMockStore } from "@/api/mock";
import type { MeProfile } from "@/api/settings";
import { AppShell } from "@/components/app-shell";
import { RequireAdmin } from "@/components/require-admin";
import { RequireAuth } from "@/components/require-auth";
import { useAuthStore } from "@/store/auth";

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

function renderRoutes(user: MeProfile | null, opts: { loading?: boolean } = {}) {
  useAuthStore.setState({
    isAuthenticated: user !== null,
    isLoading: opts.loading ?? false,
    user,
  });
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/settings" element={<div>设置页内容</div>} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<div>系统管理内容</div>} />
          </Route>
        </Route>
        <Route path="/login" element={<div>登录页内容</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderShell(user: MeProfile | null) {
  useAuthStore.setState({ isAuthenticated: user !== null, isLoading: false, user });
  return render(
    <MemoryRouter initialEntries={["/letters"]}>
      <AppShell>
        <div>页面内容</div>
      </AppShell>
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

// F3 / ONE-331 冻结契约：/admin 仅 admin；非 admin 访问重定向 /settings，不显示内容。
describe("/admin 路由守卫", () => {
  it("管理员：可进入 /admin", () => {
    renderRoutes(baseUser());

    expect(screen.getByText("系统管理内容")).toBeInTheDocument();
    expect(screen.queryByText("设置页内容")).not.toBeInTheDocument();
  });

  it("普通用户：访问 /admin 被重定向到 /settings，不渲染管理内容", () => {
    renderRoutes(memberUser());

    expect(screen.getByText("设置页内容")).toBeInTheDocument();
    expect(screen.queryByText("系统管理内容")).not.toBeInTheDocument();
  });

  it("鉴权未决：先展示加载态，不误判角色也不闪跳 /settings", () => {
    renderRoutes(null, { loading: true });

    expect(screen.getByText("加载中…")).toBeInTheDocument();
    expect(screen.queryByText("系统管理内容")).not.toBeInTheDocument();
    expect(screen.queryByText("设置页内容")).not.toBeInTheDocument();
  });

  it("未登录：落到 /login", () => {
    renderRoutes(null);

    expect(screen.getByText("登录页内容")).toBeInTheDocument();
    expect(screen.queryByText("系统管理内容")).not.toBeInTheDocument();
  });
});

describe("导航 · 系统管理菜单项", () => {
  it("管理员：同时看到「设置」与「系统管理」", () => {
    renderShell(baseUser());

    expect(screen.getByRole("link", { name: /设置/ })).toBeInTheDocument();
    const adminLink = screen.getByRole("link", { name: /系统管理/ });
    expect(adminLink).toHaveAttribute("href", "/admin");
  });

  it("普通用户：看不到「系统管理」", () => {
    renderShell(memberUser());

    expect(screen.getByRole("link", { name: /设置/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /系统管理/ })).not.toBeInTheDocument();
  });
});
