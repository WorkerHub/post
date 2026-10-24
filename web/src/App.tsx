import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";

import { useAuthStore } from "@/store/auth";
import PublicWallPage from "@/pages/public-wall";
import LoginPage from "@/pages/login";
import ComposePage from "@/pages/compose";
import LettersPage from "@/pages/letters";
import WorkbenchPage from "@/pages/workbench";
import ContactsPage from "@/pages/contacts";
import SettingsPage from "@/pages/settings";
import { RequireAuth } from "@/components/require-auth";

// v1 基线：会话为 HttpOnly Cookie，本单先以 mock 登录态跑通路由骨架，
// 鉴权 API 就绪后在 RequireAuth 内接入会话探测。
export default function App() {
  const [ready] = useState(true);
  const clear = useAuthStore((s) => s.clear);
  useEffect(() => void clear(), [clear]);

  if (!ready) return null;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PublicWallPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<WorkbenchPage />} />
          <Route path="/compose" element={<ComposePage />} />
          <Route path="/letters" element={<LettersPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
