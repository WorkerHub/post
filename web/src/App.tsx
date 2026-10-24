import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { RequireAuth } from "@/components/require-auth";
import ContactsPage from "@/pages/contacts";
import LettersPage from "@/pages/letters";
import LoginPage from "@/pages/login";
import PublicWallPage from "@/pages/public-wall";
import SettingsPage from "@/pages/settings";

// 写信页按需加载：TipTap/ProseMirror 体积较大，仅访问 /compose 时才拉取，
// 避免公开信墙等首屏页面背负编辑器依赖。
const ComposePage = lazy(() => import("@/pages/compose"));

// 路由骨架（SPEC §9）：
// - `/` 未登录为公开信墙；登录态由 PublicWallPage 分流重定向到 `/letters` 工作台。
// - 其余受保护页统一经 RequireAuth 守卫（未登录跳 `/login`，登录后套 AppShell）。
export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="py-16 text-center text-sm text-ink-500">加载中…</div>}>
        <Routes>
          <Route path="/" element={<PublicWallPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/letters" element={<LettersPage />} />
            <Route path="/compose/:id?" element={<ComposePage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
