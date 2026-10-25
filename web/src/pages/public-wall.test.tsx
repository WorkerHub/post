import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RequireAuth } from "@/components/require-auth";
import { fetchPublicLetters } from "@/api/public";
import type { PublicLetter } from "@/api/types";
import type { MeProfile } from "@/api/settings";
import { SAMPLE_LETTERS } from "@/data/sample-letters";
import { useAuthStore } from "@/store/auth";
import { useSetupStore } from "@/store/setup";
import { APP_VERSION } from "@/lib/version";

vi.mock("@/api/public", () => ({
  fetchPublicLetters: vi.fn(),
}));

import ContactsPage from "./contacts";
import LettersPage from "./letters";
import LoginPage from "./login";
import PublicWallPage from "./public-wall";
import SettingsPage from "./settings";

const SAMPLE_TITLES = SAMPLE_LETTERS.map((s) => s.title);

function realLetter(i: number, overrides: Partial<PublicLetter> = {}): PublicLetter {
  return {
    id: `real-${i}`,
    title: `真实信件${i}`,
    body_html: "<p>真实公开信内容</p>",
    send_at: "2027-01-01T01:00:00.000Z",
    sent_at: null,
    created_at: "2026-10-24T01:00:00.000Z",
    recipient_masked: "***@gmail.com",
    author_name: "",
    ...overrides,
  };
}

function mockApi(letters: PublicLetter[], totalSent = 128) {
  vi.mocked(fetchPublicLetters).mockResolvedValue({
    total_sent: totalSent,
    letters,
  });
}

function mockUser(displayName: string | null): MeProfile {
  return {
    id: "u-test",
    email: "a@b.com",
    role: "user",
    is_active: true,
    approval_status: "approved",
    display_name: displayName ?? "",
    timezone: "Asia/Shanghai",
    language: "zh",
    created_at: "2026-10-24T00:00:00.000Z",
    twofa: { totp_enabled: false, passkey_enabled: false, preferred_method: null },
  };
}

// 与 App.tsx 同构的路由表，验证真实分流/守卫逻辑
function renderApp(initial = "/", authed = false, displayName: string | null = null) {
  useAuthStore.setState({
    isAuthenticated: authed,
    user: authed ? mockUser(displayName) : null,
    isLoading: false,
  });
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<PublicWallPage />} />
        <Route path="/setup" element={<div>初始化占位</div>} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/letters" element={<LettersPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(fetchPublicLetters).mockReset();
  useSetupStore.setState({ enabled: false });
});

afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null, isLoading: false });
  useSetupStore.setState({ enabled: null });
});

describe("公开信墙渲染状态族（先等数据加载完成再断言）", () => {
  it("空墙：展示 3 封示例信且全部带「示例」Badge", async () => {
    mockApi([]);
    renderApp();
    expect(await screen.findByText("128")).toBeInTheDocument();
    expect(screen.getAllByText("示例")).toHaveLength(3);
    for (const title of SAMPLE_TITLES) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it("footer 只展示构建期版本号（ONE-333）", async () => {
    mockApi([]);
    const { container } = renderApp();
    expect(await screen.findByText("128")).toBeInTheDocument();
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer).toHaveTextContent(APP_VERSION);
    // 原 footer 文案已整体替换，不再残留
    expect(footer).not.toHaveTextContent("的定时寄信服务");
  });

  it("1 封真实信：真实信无 Badge，补位 2 封示例信带 Badge", async () => {
    mockApi([realLetter(1)]);
    renderApp();
    expect(await screen.findByText("真实信件1")).toBeInTheDocument();
    expect(screen.getAllByText("示例")).toHaveLength(2);
    expect(screen.getByText(SAMPLE_TITLES[0])).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_TITLES[1])).toBeInTheDocument();
    expect(screen.queryByText(SAMPLE_TITLES[2])).not.toBeInTheDocument();
  });

  it("2 封真实信：补位 1 封示例信带 Badge", async () => {
    mockApi([realLetter(1), realLetter(2)]);
    renderApp();
    expect(await screen.findByText("真实信件2")).toBeInTheDocument();
    expect(screen.getAllByText("示例")).toHaveLength(1);
    expect(screen.getByText(SAMPLE_TITLES[0])).toBeInTheDocument();
    expect(screen.queryByText(SAMPLE_TITLES[1])).not.toBeInTheDocument();
    expect(screen.queryByText(SAMPLE_TITLES[2])).not.toBeInTheDocument();
  });

  it("满 3 封真实信：示例信完全让位", async () => {
    mockApi([realLetter(1), realLetter(2), realLetter(3)]);
    renderApp();
    expect(await screen.findByText("真实信件3")).toBeInTheDocument();
    expect(screen.queryByText("示例")).not.toBeInTheDocument();
    for (const title of SAMPLE_TITLES) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });

  it("API 失败时不伪造数据：错误提示 + 空墙示例信，无伪造 128", async () => {
    vi.mocked(fetchPublicLetters).mockRejectedValue(new Error("network"));
    renderApp();
    expect(await screen.findByText(/公开信墙暂时无法加载/)).toBeInTheDocument();
    expect(screen.queryByText("128")).not.toBeInTheDocument();
    expect(screen.getAllByText("示例")).toHaveLength(3);
  });

  it("真实信卡片：邮箱打码显示、无昵称兜底「一位朋友」", async () => {
    mockApi([realLetter(1, { author_name: "" })]);
    renderApp();
    const card = (await screen.findByText("真实信件1")).closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    const scoped = within(card as HTMLElement);
    expect(scoped.getByText(/一位朋友/)).toBeInTheDocument();
    expect(scoped.getByText(/\*\*\*@gmail\.com/)).toBeInTheDocument();
  });

  it("有昵称时显示发信人昵称", async () => {
    mockApi([realLetter(1, { author_name: "小明" })]);
    renderApp();
    const card = (await screen.findByText("真实信件1")).closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    const scoped = within(card as HTMLElement);
    expect(scoped.getByText(/小明/)).toBeInTheDocument();
    expect(scoped.queryByText(/一位朋友/)).not.toBeInTheDocument();
  });
});

describe("受保护路由与工作台入口族", () => {
  it("未登录访问 `/` 展示公开信墙", async () => {
    mockApi([]);
    renderApp("/");
    expect(await screen.findByText("128")).toBeInTheDocument();
  });

  it("登录后访问 `/` 重定向到 `/letters` 工作台", async () => {
    mockApi([]);
    renderApp("/", true, "小满");
    expect(await screen.findByText(/你好，小满/)).toBeInTheDocument();
    expect(screen.queryByText("128")).not.toBeInTheDocument();
  });

  it("登录后直接访问 `/letters` 展示工作台", async () => {
    renderApp("/letters", true, "小满");
    expect(await screen.findByText(/你好，小满/)).toBeInTheDocument();
    // 顶栏导航与工作台卡片均含「我的信件」入口
    expect(screen.getAllByText(/我的信件/).length).toBeGreaterThan(0);
  });

  it("登录后 displayName 为 null 时用「朋友」兜底，不踢回登录页", async () => {
    renderApp("/letters", true, null);
    expect(await screen.findByText(/你好，朋友/)).toBeInTheDocument();
    expect(screen.queryByText(/登录时光邮局/)).not.toBeInTheDocument();
  });

  it("未登录访问 `/letters` 跳转 `/login`", async () => {
    renderApp("/letters", false);
    expect(await screen.findByText(/登录时光邮局/)).toBeInTheDocument();
  });

  it("未登录访问 `/contacts` 跳转 `/login`", async () => {
    renderApp("/contacts", false);
    expect(await screen.findByText(/登录时光邮局/)).toBeInTheDocument();
  });

  it("登录后访问 `/contacts` 在登录壳内渲染占位页", async () => {
    renderApp("/contacts", true, "小满");
    // 顶栏导航 + 页面标题均含「联系人」
    expect((await screen.findAllByText(/联系人/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/登录时光邮局/)).not.toBeInTheDocument();
  });

  it("登录后访问 `/settings` 在登录壳内渲染占位页", async () => {
    renderApp("/settings", true, "小满");
    expect((await screen.findAllByText(/设置/)).length).toBeGreaterThan(0);
  });
});

describe("未初始化时的首页入口（ONE-314）", () => {
  it("setup enabled 时首页给出「完成初始化」入口并指向 /setup", async () => {
    mockApi([]);
    useSetupStore.setState({ enabled: true });
    renderApp();

    expect(await screen.findByText(/本站尚未完成初始化/)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /完成初始化/ });
    expect(cta).toHaveAttribute("href", "/setup");
  });

  it("setup 已关闭时不展示初始化入口", async () => {
    mockApi([]);
    useSetupStore.setState({ enabled: false });
    renderApp();

    expect(await screen.findByText("128")).toBeInTheDocument();
    expect(screen.queryByText(/本站尚未完成初始化/)).not.toBeInTheDocument();
  });
});
