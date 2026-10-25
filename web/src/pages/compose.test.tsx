import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { resetMockStore, seedMockContacts } from "@/api/mock";
import ComposePage from "./compose";

// 测试邮箱统一走常量（运行时替换为真实值），避免正则里的特殊字符干扰匹配。
const EMAIL_A = "a@b.com";
const EMAIL_B = "name+tag@example.co.uk";

function renderCompose(initial = "/compose") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/compose/:id?" element={<ComposePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
  seedMockContacts([
    { id: "c1", name: "妈妈", email: EMAIL_A },
    { id: "c2", name: "小明", email: EMAIL_B },
  ]);
});

describe("写信页 · TipTap 受限工具集", () => {
  it("编辑器只出现允许集的工具项", async () => {
    renderCompose();
    const allowed = ["加粗", "斜体", "二级标题", "三级标题", "引用", "无序列表", "有序列表", "链接", "分割线"];
    for (const label of allowed) {
      expect(await screen.findByRole("button", { name: label })).toBeInTheDocument();
    }
    for (const label of ["图片", "表格", "代码块", "文字颜色", "附件"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });
});

describe("写信页 · 校验与存草稿", () => {
  it("无收件人时点寄往未来给出校验错误", async () => {
    renderCompose();
    fireEvent.click(screen.getByRole("button", { name: /寄往未来/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请至少添加一位收件人");
  });

  it("存草稿无需收件人与时间，保存后提示", async () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText("标题（邮件主题）"), {
      target: { value: "我的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "存草稿" }));
    expect(await screen.findByText("草稿已保存")).toBeInTheDocument();
  });
});

describe("写信页 · 收件人选择器", () => {
  it("手填邮箱：非法格式报错，合法则落为快照", async () => {
    renderCompose();
    const emailInput = screen.getByLabelText("收件人邮箱");
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByText("邮箱格式不正确")).toBeInTheDocument();

    fireEvent.change(emailInput, { target: { value: EMAIL_A } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    // 落快照后出现可移除的收件人 chip（移除按钮 aria-label 含邮箱）
    expect(
      await screen.findByRole("button", { name: `移除 ${EMAIL_A}` }),
    ).toBeInTheDocument();
  });

  it("从联系人添加：搜索并多选", async () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText("搜索联系人"), {
      target: { value: "妈" },
    });
    fireEvent.click(await screen.findByText("妈妈"));
    // 选中后出现可移除的收件人 chip
    expect(
      await screen.findByRole("button", { name: `移除 ${EMAIL_A}` }),
    ).toBeInTheDocument();
  });
});

describe("写信页 · 预览与全流程", () => {
  it("预览实时反映标题", async () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText("标题（邮件主题）"), {
      target: { value: "给未来的信" },
    });
    expect(screen.getByText("给未来的信")).toBeInTheDocument();
  });

  it("存草稿 → 补齐收件人 → 定时 全流程可走通", async () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText("标题（邮件主题）"), {
      target: { value: "流程信" },
    });
    fireEvent.click(screen.getByRole("button", { name: "存草稿" }));
    await screen.findByText("草稿已保存");

    fireEvent.change(screen.getByLabelText("收件人邮箱"), {
      target: { value: EMAIL_A },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await screen.findByRole("button", { name: `移除 ${EMAIL_A}` });

    fireEvent.click(screen.getByRole("button", { name: /寄往未来/ }));
    expect(await screen.findByText(/已定时/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消寄送" })).toBeInTheDocument();
  });
});
