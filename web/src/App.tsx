import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { RequireAdmin } from "@/components/require-admin";
import { RequireAuth } from "@/components/require-auth";
import { SessionBootstrap } from "@/components/session-bootstrap";
import AdminPage from "@/pages/admin";
import AboutPage from "@/pages/about";
import ContactsPage from "@/pages/contacts";
import LettersPage from "@/pages/letters";
import LoginPage from "@/pages/login";
import PublicWallPage from "@/pages/public-wall";
import RegisterPage from "@/pages/register";
import SettingsPage from "@/pages/settings";
import SetupPage from "@/pages/setup";

// 写信页按需加载：TipTap/ProseMirror 体积较大，仅访问 /compose 时才拉取，
// 避免公开信墙等首屏页面背负编辑器依赖。
const ComposePage = lazy(() => import("@/pages/compose"));

// 路由骨架（SPEC §9）：
// - `/` 未登录为公开信墙；登录态由 PublicWallPage 分流重定向到 `/letters` 工作台。
// - 其余受保护页统一经 RequireAuth 守卫（未登录跳 `/login`，登录后套 AppShell）。
// - `/about` 公开（ONE-337），与 `/`、`/login`、`/register` 同层。
// - `/admin`（系统管理）再套一层 RequireAdmin：非 admin 重定向 `/settings`（F3 / ONE-331）。
export default function App() {
  return (
    <BrowserRouter>
      <SessionBootstrap />
      <Suspense fallback={<div className="py-16 text-center text-sm text-ink-500">加载中…</div>}>
        <Routes>
          <Route path="/" element={<PublicWallPage />} />
          {/* 关于页公开可访问（ONE-337）：不套 RequireAuth，未登录也能看 */}
          <Route path="/about" element={<AboutPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/letters" element={<LettersPage />} />
            <Route path="/compose/:id?" element={<ComposePage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="/admin" element={<AdminPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
