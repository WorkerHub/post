import { readFileSync } from "node:fs";
import path from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import { fetchPublicLetters } from "@/api/public";
import { APP_BUILD_TIME, APP_VERSION } from "@/lib/version";
import { useAuthStore } from "@/store/auth";
import { useSetupStore } from "@/store/setup";

import {
  PRODUCT_NAME,
  PRODUCT_TAGLINE,
  REPO_URL,
  formatBuildTime,
} from "./about";

vi.mock("@/api/public", () => ({
  fetchPublicLetters: vi.fn(),
}));

// 走真实 App 路由表（而不是在测试里另搭一份同构路由），
// 这样 `/about` 是否真的挂在 RequireAuth 之外由 App.tsx 自己证明。
function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

beforeEach(() => {
  vi.mocked(fetchPublicLetters).mockResolvedValue({ total_sent: 128, letters: [] });
  useAuthStore.setState({ isAuthenticated: false, user: null, isLoading: false });
  useSetupStore.setState({ enabled: false });
});

afterEach(() => {
  vi.mocked(fetchPublicLetters).mockReset();
  useAuthStore.setState({ isAuthenticated: false, user: null, isLoading: true });
  useSetupStore.setState({ enabled: null });
  window.history.pushState({}, "", "/");
});

describe("关于页内容族（ONE-337）", () => {
  it("未登录访问 /about 直接可见：产品名、副标题、简介", () => {
    renderAppAt("/about");

    // 未被 RequireAuth 拦到 /login
    expect(screen.queryByText(/登录时光邮局/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: PRODUCT_NAME })).toBeInTheDocument();
    expect(screen.getByText(PRODUCT_TAGLINE)).toBeInTheDocument();
    expect(screen.getByText(/挑一个未来的日期/)).toBeInTheDocument();
  });

  it("产品名与 web/index.html 的 <title> 文案一致", () => {
    // 直接读构建入口的 title，防止两处文案漂移
    // vitest 的 cwd 是 web/（vite.config.ts 所在目录）
    const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");
    expect(html).toContain(`<title>${PRODUCT_NAME}</title>`);
  });

  it("技术栈区块覆盖运行时、后端、前端三组", () => {
    renderAppAt("/about");

    expect(screen.getByText("运行时与存储")).toBeInTheDocument();
    expect(screen.getByText("后端")).toBeInTheDocument();
    expect(screen.getByText("前端")).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare Workers/)).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare D1/)).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare KV/)).toBeInTheDocument();
    expect(screen.getByText(/^Hono \+ TypeScript$/)).toBeInTheDocument();
    expect(screen.getByText(/React 19 \+ Vite \+ TypeScript/)).toBeInTheDocument();
    expect(screen.getByText(/Zustand/)).toBeInTheDocument();
  });

  it("开源地址固定为 WorkerHub/post，外链新开页并带 noopener", () => {
    renderAppAt("/about");

    const repo = screen.getByRole("link", { name: /github\.com\/WorkerHub\/post/ });
    expect(repo).toHaveAttribute("href", REPO_URL);
    expect(REPO_URL).toBe("https://github.com/WorkerHub/post");
    expect(repo).toHaveAttribute("target", "_blank");
    expect(repo.getAttribute("rel")).toContain("noopener");
  });

  it("版本号与构建时间来自构建期注入，不写死", () => {
    const { container } = renderAppAt("/about");

    expect(screen.getByText(APP_VERSION, { selector: "span" })).toBeInTheDocument();

    const buildTime = container.querySelector("time");
    expect(buildTime).not.toBeNull();
    expect(buildTime).toHaveAttribute("datetime", APP_BUILD_TIME);
    expect(buildTime).toHaveTextContent(formatBuildTime(APP_BUILD_TIME));
  });
});

describe("公开墙 footer 的「关于」入口族", () => {
  it("footer 同时保留版本号与「关于」链接", async () => {
    const { container } = renderAppAt("/");
    expect(await screen.findByText("128")).toBeInTheDocument();

    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer).toHaveTextContent(APP_VERSION);
    const about = screen.getByRole("link", { name: "关于" });
    expect(about).toHaveAttribute("href", "/about");
  });

  it("点击 footer「关于」进入 /about 并能看到内容", async () => {
    renderAppAt("/");
    expect(await screen.findByText("128")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "关于" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: PRODUCT_NAME }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/about");
  });

  it("已登录用户也能访问 /about（公开页不依赖登录态）", () => {
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      user: {
        id: "u-test",
        email: "a@b.com",
        role: "admin",
        is_active: true,
        approval_status: "approved",
        display_name: "小满",
        timezone: "Asia/Shanghai",
        language: "zh",
        created_at: "2026-10-24T00:00:00.000Z",
        twofa: { totp_enabled: false, passkey_enabled: false, preferred_method: null },
      },
    });

    renderAppAt("/about");

    expect(screen.getByRole("heading", { level: 1, name: PRODUCT_NAME })).toBeInTheDocument();
    // 公开页不套 AppShell（无工作台导航）
    expect(screen.queryByRole("link", { name: /我的信件/ })).not.toBeInTheDocument();
  });
});

describe("formatBuildTime（展示层裁剪，不改来源）", () => {
  it("ISO 串裁成 YYYY-MM-DD HH:mm:ss UTC", () => {
    expect(formatBuildTime("2026-10-25T15:21:01.512Z")).toBe("2026-10-25 15:21:01 UTC");
  });

  it("无法解析时原样返回，不伪造时间", () => {
    expect(formatBuildTime("not-a-time")).toBe("not-a-time");
  });
});
