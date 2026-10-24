import { Navigate, Outlet } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { useAuthStore } from "@/store/auth";

// 登录态路由守卫：未登录访问受保护页时跳回登录页；登录后统一套登录壳 AppShell。
export function RequireAuth() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
