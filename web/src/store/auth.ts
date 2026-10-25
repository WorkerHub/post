import { create } from "zustand";

import type { MeProfile } from "@/api/settings";

// 登录态：后端会话为 HttpOnly Cookie，前端通过 GET /api/me 自描述会话。
// 登录成功后把用户档案（含 role）存进 store，供导航壳、设置页、管理后台使用。
//
// isLoading 表示「鉴权初始化未决」：冷启动时 SessionBootstrap 尚未完成 fetchMe，
// 此时不能因 isAuthenticated=false 就踢人（否则刷新/书签直达受保护路由会闪回 /login）。
interface AuthState {
  isAuthenticated: boolean;
  user: MeProfile | null;
  /** 鉴权初始化是否未决（初始 true，fetchMe 成功/失败后置 false）。 */
  isLoading: boolean;
  setUser: (user: MeProfile) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  user: null,
  isLoading: true,
  setUser: (user) => set({ isAuthenticated: true, user, isLoading: false }),
  clear: () => set({ isAuthenticated: false, user: null, isLoading: false }),
}));
