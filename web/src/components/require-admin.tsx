import { Navigate, Outlet } from "react-router-dom";

import { useAuthStore } from "@/store/auth";

// admin 路由守卫（F3 / ONE-331 冻结契约）：
// - 已登录且 role === "admin" → 放行；
// - 已登录但非 admin → 重定向 /settings，不渲染任何管理内容；
// - 鉴权未决（冷启动 fetchMe 中）→ 先展示加载态，避免误判角色；
// - 未登录 → 回登录页（正常情况下 RequireAuth 已先行拦截，这里兜底）。
// 说明：真实鉴权以后端 adminMiddleware 为准，这里只是前端可见性/路由分流。
export function RequireAdmin() {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);

  if (isLoading || (isAuthenticated && !user)) {
    return <div className="py-16 text-center text-sm text-ink-500">加载中…</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (user?.role !== "admin") {
    return <Navigate to="/settings" replace />;
  }
  return <Outlet />;
}
