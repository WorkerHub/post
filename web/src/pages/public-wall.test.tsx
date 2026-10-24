import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import PublicWallPage from "./public-wall";
import { useAuthStore } from "@/store/auth";

function renderWall() {
  return render(
    <MemoryRouter>
      <PublicWallPage />
    </MemoryRouter>,
  );
}

describe("PublicWallPage", () => {
  it("展示站点名、介绍与已寄出计数（mock）", async () => {
    renderWall();
    expect(screen.getAllByText("时光邮局").length).toBeGreaterThan(0);
    expect(screen.getByText("写一封信，寄往未来的某一天。")).toBeInTheDocument();
    expect(await screen.findByText("128")).toBeInTheDocument();
  });

  it("墙为空时展示标注「示例」的示例信", async () => {
    renderWall();
    const badges = await screen.findAllByText("示例");
    expect(badges.length).toBe(3);
    expect(screen.getAllByText("写给三年后的自己").length).toBeGreaterThan(0);
  });

  it("发信人无昵称时兜底显示「一位朋友」，收件邮箱打码", async () => {
    renderWall();
    expect(await screen.findAllByText(/一位朋友/)).toBeTruthy();
    expect(screen.getAllByText(/\*\*\*@gmail\.com/).length).toBeGreaterThan(0);
  });

  it("登录后访问 / 跳转工作台", () => {
    useAuthStore.setState({ isAuthenticated: true, displayName: "小满" });
    renderWall();
    // 信墙内容不再出现，说明已重定向离开 /
    expect(screen.queryByText("写一封信，寄往未来的某一天。")).not.toBeInTheDocument();
    useAuthStore.setState({ isAuthenticated: false, displayName: null });
  });
});
