import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { lettersApi } from "@/api/client";
import type { Letter } from "@/api/letters";
import { resetMockStore, seedMockLetters } from "@/api/mock";
import LettersPage from "./letters";

function letter(overrides: Partial<Letter> = {}): Letter {
  return {
    id: "l1",
    title: "测试信",
    body_html: "<p>正文</p>",
    body_json: "{}",
    send_at: "2030-01-01T01:00:00.000Z",
    timezone: "Asia/Shanghai",
    is_public: false,
    recipients: [{ contact_id: null, name: "", email: "a@b.com" }],
    status: "draft",
    attempts: 0,
    last_error: null,
    sent_at: null,
    created_at: "2026-10-24T01:00:00.000Z",
    updated_at: "2026-10-24T01:00:00.000Z",
    ...overrides,
  };
}

function renderLetters() {
  return render(
    <MemoryRouter>
      <LettersPage />
    </MemoryRouter>,
  );
}

function clickTab(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

beforeEach(() => {
  resetMockStore();
});

describe("工作台 · 四视图状态", () => {
  it("按状态分组到草稿/待寄出/已寄出/失败四个视图", async () => {
    seedMockLetters([
      letter({ id: "l-draft", title: "草稿信", status: "draft" }),
      letter({ id: "l-scheduled", title: "定时信", status: "scheduled" }),
      letter({ id: "l-sent", title: "已寄信", status: "sent", sent_at: "2026-10-24T01:00:00.000Z" }),
      letter({ id: "l-failed", title: "失败信", status: "failed", attempts: 3, last_error: "SMTP 认证失败" }),
    ]);
    renderLetters();

    // 默认草稿视图
    expect(await screen.findByText("草稿信")).toBeInTheDocument();
    expect(screen.queryByText("定时信")).not.toBeInTheDocument();

    // 可编辑状态标题进编辑器
    expect(screen.getByRole("link", { name: "草稿信" })).toHaveAttribute(
      "href",
      "/compose/l-draft",
    );

    clickTab(/待寄出/);
    expect(screen.getByText("定时信")).toBeInTheDocument();
    expect(screen.queryByText("草稿信")).not.toBeInTheDocument();

    // 不可编辑状态标题进只读详情页（已寄出 / 失败）
    clickTab(/已寄出/);
    expect(screen.getByText("已寄信")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "已寄信" })).toHaveAttribute(
      "href",
      "/letters/l-sent",
    );

    clickTab(/失败/);
    expect(screen.getByText("失败信")).toBeInTheDocument();
    expect(screen.getByText(/SMTP 认证失败/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "失败信" })).toHaveAttribute(
      "href",
      "/letters/l-failed",
    );
  });
});

describe("工作台 · 失败重发（attempts 归零）", () => {
  it("失败视图展示 last_error，重发确认后 attempts 归零并回到待寄出", async () => {
    seedMockLetters([
      letter({ id: "l-failed", title: "失败信", status: "failed", attempts: 3, last_error: "认证失败" }),
    ]);
    renderLetters();

    clickTab(/失败/);
    expect(await screen.findByText(/认证失败/)).toBeInTheDocument();
    expect(screen.getByText(/已尝试 3 次/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重发" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/重置重试次数为 0/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认重发" }));

    // 失败视图清空
    await waitFor(() => expect(screen.getByText("没有寄送失败的信")).toBeInTheDocument());

    // attempts 归零 + 状态回 scheduled
    const after = await lettersApi.get("l-failed");
    expect(after.status).toBe("scheduled");
    expect(after.attempts).toBe(0);
    expect(after.last_error).toBeNull();
  });
});

describe("工作台 · 待寄出取消", () => {
  it("待寄出视图可取消，取消后回到草稿视图并带「已取消」徽标", async () => {
    seedMockLetters([
      letter({ id: "l-sched", title: "定时信", status: "scheduled" }),
    ]);
    renderLetters();

    clickTab(/待寄出/);
    expect(await screen.findByText("定时信")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认取消" }));

    await waitFor(() => expect(screen.getByText("没有待寄出的信")).toBeInTheDocument());

    clickTab(/草稿/);
    expect(screen.getByText("定时信")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });
});
