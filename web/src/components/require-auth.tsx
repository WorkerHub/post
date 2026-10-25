import { Navigate, Outlet } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { useAuthStore } from "@/store/auth";

// 登录态路由守卫：鉴权初始化未决时先展示加载态（刷新/书签直达受保护路由不闪回 /login），
// 初始化完成后再按 isAuthenticated 放行或跳登录页；登录后统一套登录壳 AppShell。
export function RequireAuth() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-ink-500">加载中…</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
