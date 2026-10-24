import { describe, expect, it } from "vitest";

import { isValidEmail } from "./validation";

describe("isValidEmail", () => {
  it("接受合法邮箱", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("name+tag@example.co.uk")).toBe(true);
  });
  it("拒绝非法邮箱", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@")).toBe(false);
    expect(isValidEmail("@b.com")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
  });
  it("忽略首尾空白", () => {
    expect(isValidEmail("  a@b.com  ")).toBe(true);
  });
});
