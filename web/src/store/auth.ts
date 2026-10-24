import { create } from "zustand";

// 登录态骨架：后端会话为 HttpOnly Cookie，前端只持有布尔标记与用户昵称，
// 登录/登出接口接通后由对应页面调用 set/clear。
interface AuthState {
  isAuthenticated: boolean;
  displayName: string | null;
  setAuthenticated: (displayName: string | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  displayName: null,
  setAuthenticated: (displayName) =>
    set({ isAuthenticated: true, displayName }),
  clear: () => set({ isAuthenticated: false, displayName: null }),
}));
