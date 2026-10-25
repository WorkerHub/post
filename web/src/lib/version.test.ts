import { describe, expect, it } from "vitest";

import { APP_BUILD_TIME, APP_VERSION } from "./version";

// 构建期注入的常量在 vitest 下同样由 vite define 静态替换，
// 因此这里断言的是「注入链路真的通了」，而不是 mock 出来的值。
describe("构建期版本注入（ONE-333）", () => {
  it("APP_VERSION 形如 v{version}-{build}-{shortsha}", () => {
    expect(APP_VERSION).toMatch(/^v\d+\.\d+\.\d+-\d+-(?:[0-9a-f]{7,40}|unknown)$/);
  });

  it("APP_VERSION 的构建号段来自 BUILD_NUMBER（缺省为 0）", () => {
    const raw = process.env.BUILD_NUMBER?.trim() ?? "";
    const expectedBuild = /^\d+$/.test(raw) ? raw : "0";
    expect(APP_VERSION).toContain(`-${expectedBuild}-`);
    expect(APP_VERSION).not.toContain("__APP_VERSION__");
    expect(APP_VERSION).not.toContain("undefined");
  });

  it("APP_BUILD_TIME 是可解析的 ISO 时间", () => {
    expect(APP_BUILD_TIME).not.toContain("__APP_BUILD_TIME__");
    expect(APP_BUILD_TIME).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(APP_BUILD_TIME))).toBe(false);
  });
});
