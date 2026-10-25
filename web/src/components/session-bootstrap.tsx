import { useEffect } from "react";

import { settingsApi } from "@/api/client";
import { useAuthStore } from "@/store/auth";

// 会话自举：HttpOnly Cookie 无法被 JS 读取，靠 GET /api/me 判定登录态。
// 成功则写入用户档案（含 role）；失败（401/网络错误）则置 isLoading=false 保持未登录。
export function SessionBootstrap() {
  const setUser = useAuthStore((s) => s.setUser);
  const clear = useAuthStore((s) => s.clear);

  useEffect(() => {
    let cancelled = false;
    settingsApi
      .fetchMe()
      .then((user) => {
        if (!cancelled) setUser(user);
      })
      .catch(() => {
        if (!cancelled) clear();
      });
    return () => {
      cancelled = true;
    };
  }, [setUser, clear]);

  return null;
}
