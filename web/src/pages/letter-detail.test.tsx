import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import type { Letter } from "@/api/letters";
import { resetMockStore, seedMockLetters } from "@/api/mock";
import LetterDetailPage from "./letter-detail";

const EMAIL_SELF = "a@b.com";

function letter(overrides: Partial<Letter> = {}): Letter {
  return {
    id: "l1",
    title: "写给未来的信",
    body_html: "<p>多年以后，你还记得这个下午吗？</p>",
    body_json: "{}",
    send_at: "2030-01-01T01:00:00.000Z",
    timezone: "Asia/Shanghai",
    is_public: false,
    recipients: [{ contact_id: null, name: "自己", email: EMAIL_SELF }],
    status: "draft",
    attempts: 0,
    last_error: null,
    sent_at: null,
    created_at: "2026-10-24T01:00:00.000Z",
    updated_at: "2026-10-24T01:00:00.000Z",
    ...overrides,
  };
}

function renderDetail(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/letters/${id}`]}>
      <Routes>
        <Route path="/letters/:id" element={<LetterDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
});

describe("信件详情 · 已寄出", () => {
  it("只读展示主题/正文/收件人与寄出信息，没有编辑入口", async () => {
    seedMockLetters([
      letter({
        id: "l-sent",
        title: "已寄出的信",
        status: "sent",
        sent_at: "2026-10-25T02:30:00.000Z",
      }),
    ]);
    renderDetail("l-sent");

    // 主题与正文（正文按邮件样式渲染 body_html）
    expect(await screen.findByText("已寄出的信")).toBeInTheDocument();
    expect(screen.getByText("多年以后，你还记得这个下午吗？")).toBeInTheDocument();

    // 状态徽标 + 返回入口
    expect(screen.getByText("已寄出")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回我的信件" })).toHaveAttribute(
      "href",
      "/letters",
    );

    // 收件人快照可见
    expect(screen.getByText(`<${EMAIL_SELF}>`)).toBeInTheDocument();

    // 已寄出不可编辑：没有任何「编辑」按钮，也没有保存/寄出动作
    expect(screen.queryByRole("link", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /存草稿|寄往未来/ })).not.toBeInTheDocument();
  });
});

describe("信件详情 · 失败", () => {
  it("展示失败原因与尝试次数，同样只读", async () => {
    seedMockLetters([
      letter({
        id: "l-failed",
        title: "失败的信",
        status: "failed",
        attempts: 3,
        last_error: "SMTP 认证失败",
      }),
    ]);
    renderDetail("l-failed");

    expect(await screen.findByText(/失败原因：SMTP 认证失败/)).toBeInTheDocument();
    expect(screen.getByText(/已尝试 3 次/)).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "编辑" })).not.toBeInTheDocument();
  });
});

describe("信件详情 · 发送中", () => {
  it("发送中的信同样只能看，不给编辑入口", async () => {
    seedMockLetters([
      letter({ id: "l-sending", title: "正在寄出的信", status: "sending" }),
    ]);
    renderDetail("l-sending");

    expect(await screen.findByText("正在寄出的信")).toBeInTheDocument();
    expect(screen.getByText("发送中")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "编辑" })).not.toBeInTheDocument();
  });
});

describe("信件详情 · 直达可编辑信件", () => {
  it("草稿直链打开给「编辑」入口，指向编辑器", async () => {
    seedMockLetters([letter({ id: "l-draft", title: "草稿信", status: "draft" })]);
    renderDetail("l-draft");

    expect(await screen.findByText("草稿信")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "编辑" })).toHaveAttribute(
      "href",
      "/compose/l-draft",
    );
  });
});

describe("信件详情 · 不存在或无权查看", () => {
  it("给出错误提示与返回入口，不回显内容", async () => {
    renderDetail("nope");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法打开这封信：信件不存在或无权查看",
    );
    expect(screen.getByRole("link", { name: /返回我的信件/ })).toHaveAttribute(
      "href",
      "/letters",
    );
    expect(screen.queryByText("写给未来的信")).not.toBeInTheDocument();
  });
});
