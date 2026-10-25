import { create } from "zustand";

import type { MeProfile } from "@/api/settings";

// 登录态：后端会话为 HttpOnly Cookie，前端通过 GET /api/me 自描述会话。
// 登录成功后把用户档案（含 role）存进 store，供导航壳、设置页、管理后台使用。
interface AuthState {
  isAuthenticated: boolean;
  user: MeProfile | null;
  setUser: (user: MeProfile) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  user: null,
  setUser: (user) => set({ isAuthenticated: true, user }),
  clear: () => set({ isAuthenticated: false, user: null }),
}));
