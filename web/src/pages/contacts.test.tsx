import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { resetMockStore, seedMockContacts } from "@/api/mock";
import ContactsPage from "./contacts";

function renderContacts() {
  return render(
    <MemoryRouter>
      <ContactsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMockStore();
});

describe("联系人页 · 搜索筛选", () => {
  it("按姓名/邮箱/标签搜索筛选列表", async () => {
    seedMockContacts([
      { id: "c1", name: "妈妈", email: "a@b.com", tags: ["家人"] },
      { id: "c2", name: "小明", email: "name+tag@example.co.uk", tags: ["同事"] },
    ]);
    renderContacts();
    expect(await screen.findByText("妈妈")).toBeInTheDocument();
    expect(screen.getByText("小明")).toBeInTheDocument();

    // 按姓名
    fireEvent.change(screen.getByLabelText("搜索联系人"), { target: { value: "小明" } });
    expect(screen.getByText("小明")).toBeInTheDocument();
    expect(screen.queryByText("妈妈")).not.toBeInTheDocument();

    // 按标签
    fireEvent.change(screen.getByLabelText("搜索联系人"), { target: { value: "家人" } });
    expect(screen.getByText("妈妈")).toBeInTheDocument();
    expect(screen.queryByText("小明")).not.toBeInTheDocument();

    // 按邮箱（完整值）
    fireEvent.change(screen.getByLabelText("搜索联系人"), { target: { value: "name+tag@example.co.uk" } });
    expect(screen.getByText("小明")).toBeInTheDocument();
    expect(screen.queryByText("妈妈")).not.toBeInTheDocument();
  });
});

describe("联系人页 · 新建与唯一校验", () => {
  it("邮箱重复时报唯一校验错误（可见）", async () => {
    seedMockContacts([{ id: "c1", name: "妈妈", email: "a@b.com" }]);
    renderContacts();
    await screen.findByText("妈妈");

    fireEvent.click(screen.getByRole("button", { name: "新建联系人" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "另一个" } });
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("已存在于联系人");
  });

  it("合法新建：含标签与备注，保存后出现在列表", async () => {
    renderContacts();
    fireEvent.click(screen.getByRole("button", { name: "新建联系人" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "同事小张" } });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "name+tag@example.co.uk" } });
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "项目对接人" } });
    fireEvent.change(screen.getByPlaceholderText("输入标签后回车"), {
      target: { value: "同事" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("输入标签后回车"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("同事小张")).toBeInTheDocument();
    const row = screen.getByText("同事小张").closest('[data-slot="card"]') as HTMLElement;
    expect(within(row).getByText("同事")).toBeInTheDocument();
    expect(within(row).getByText("项目对接人")).toBeInTheDocument();
  });
});

describe("联系人页 · 编辑与删除", () => {
  it("编辑后字段更新", async () => {
    seedMockContacts([{ id: "c1", name: "妈妈", email: "a@b.com" }]);
    renderContacts();
    await screen.findByText("妈妈");

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "老妈" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("老妈")).toBeInTheDocument();
    expect(screen.queryByText("妈妈")).not.toBeInTheDocument();
  });

  it("删除前确认，确认后移除", async () => {
    seedMockContacts([{ id: "c1", name: "妈妈", email: "a@b.com" }]);
    renderContacts();
    await screen.findByText("妈妈");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    // 确认弹窗
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(screen.queryByText("妈妈")).not.toBeInTheDocument());
  });
});
