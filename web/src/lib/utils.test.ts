import { describe, expect, it } from "vitest";

import { formatDate, maskEmail } from "./utils";

describe("maskEmail", () => {
  it("保留域名并打码本地部分", () => {
    expect(maskEmail("someone@gmail.com")).toBe("***@gmail.com");
    expect(maskEmail("***@163.com")).toBe("***@163.com");
  });
  it("无 @ 或无域名部分时返回空串，不产生悬挂的 ***@", () => {
    expect(maskEmail("not-an-email")).toBe("");
    expect(maskEmail("a@")).toBe("");
  });
  it("空值返回空串，不抛错", () => {
    expect(maskEmail(null)).toBe("");
    expect(maskEmail(undefined)).toBe("");
    expect(maskEmail("")).toBe("");
  });
});

describe("formatDate", () => {
  it("格式化为 YYYY-MM-DD（本地时区）", () => {
    expect(formatDate("2026-10-24T01:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("空值返回空串", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
  });
  it("非法日期返回空串", () => {
    expect(formatDate("not-a-date")).toBe("");
  });
});
