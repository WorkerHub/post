import { Navigate, Outlet } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { useAuthStore } from "@/store/auth";

// 登录态路由守卫：未登录访问受保护页时跳回登录页。
// 登录后 `/` 切「我的信件」工作台的逻辑同样挂在工作台页内。
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
