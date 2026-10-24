import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { RequireAuth } from "@/components/require-auth";
import ComposePage from "@/pages/compose";
import ContactsPage from "@/pages/contacts";
import LettersPage from "@/pages/letters";
import LoginPage from "@/pages/login";
import PublicWallPage from "@/pages/public-wall";
import SettingsPage from "@/pages/settings";

// 路由骨架（SPEC §9）：
// - `/` 未登录为公开信墙；登录态由 PublicWallPage 分流重定向到 `/letters` 工作台。
// - 其余受保护页统一经 RequireAuth 守卫（未登录跳 `/login`，登录后套 AppShell）。
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PublicWallPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/letters" element={<LettersPage />} />
          <Route path="/compose" element={<ComposePage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
