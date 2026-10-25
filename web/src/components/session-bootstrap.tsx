import { useEffect } from "react";

import { authApi, settingsApi, setupApi } from "@/api/client";
import { useAuthStore } from "@/store/auth";
import { useRegistrationStore } from "@/store/registration";
import { useSetupStore } from "@/store/setup";

// 会话自举：HttpOnly Cookie 无法被 JS 读取，靠 GET /api/me 判定登录态。
// 成功则写入用户档案（含 role）；失败（401/网络错误）则置 isLoading=false 保持未登录。
//
// 同时自举 setup 状态（GET /api/setup/state）：未初始化时把入口引导到 /setup。
// 取值失败保持 null——不阻断任何页面，由具体页面自行兜底。
// setup 页面开关关闭时该接口 404（ONE-320），同样落到 null（不会把任何人引到 /setup）。
//
// 另自举注册开关（GET /api/auth/registration-state，ONE-336）：注册页与登录页据此
// 隐藏注册入口；取值失败同样保持 null——不因读不到状态就把注册关掉。
export function SessionBootstrap() {
  const setUser = useAuthStore((s) => s.setUser);
  const clear = useAuthStore((s) => s.clear);
  const setSetupEnabled = useSetupStore((s) => s.setEnabled);
  const setRegistrationEnabled = useRegistrationStore((s) => s.setEnabled);

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

  useEffect(() => {
    let cancelled = false;
    setupApi
      .fetchState()
      .then(({ enabled }) => {
        if (!cancelled) setSetupEnabled(enabled);
      })
      .catch(() => {
        if (!cancelled) setSetupEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, [setSetupEnabled]);

  useEffect(() => {
    let cancelled = false;
    authApi
      .getRegistrationState()
      .then(({ enabled }) => {
        if (!cancelled) setRegistrationEnabled(enabled);
      })
      .catch(() => {
        if (!cancelled) setRegistrationEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, [setRegistrationEnabled]);

  return null;
}
