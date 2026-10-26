import { create } from "zustand";

// 注册开关状态（GET /api/auth/registration-state，ONE-330 冻结契约）；
// null = 尚未取得（自举中或取值失败）。
//
// 用途：注册页是否展示注册表单、登录页是否显示「注册」入口。由 SessionBootstrap
// 自举一次，管理员在系统管理页切换开关后回写，全局保持一致（与 store/setup.ts 同形）。
// 取值失败一律不关门（null 按开启处理）：后端 POST /api/auth/register 才是最终裁决，
// 前端只因明确读到「已关闭」才隐藏入口。
interface RegistrationStore {
  enabled: boolean | null;
  setEnabled: (enabled: boolean | null) => void;
}

export const useRegistrationStore = create<RegistrationStore>((set) => ({
  enabled: null,
  setEnabled: (enabled) => set({ enabled }),
}));
