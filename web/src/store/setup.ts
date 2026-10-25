import { create } from "zustand";

// 初始化状态（GET /api/setup/state）：null = 尚未取得（自举中或取值失败）。
//
// 用途：决定「是否把用户引导到 /setup」。仅凭页面各自请求会在各页重复打点，
// 这里由 SessionBootstrap 自举一次，setup 页成功后回写，全局保持一致。
interface SetupStore {
  enabled: boolean | null;
  setEnabled: (enabled: boolean | null) => void;
}

export const useSetupStore = create<SetupStore>((set) => ({
  enabled: null,
  setEnabled: (enabled) => set({ enabled }),
}));
