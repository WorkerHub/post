import { describe, expect, it } from "vitest";

import {
  getDefaultSendAt,
  getUserTimezone,
  isAfterNow,
  toLocalInputValue,
  toUtcIso,
} from "./datetime";

describe("getUserTimezone", () => {
  it("返回非空时区字符串（兜底 Asia/Shanghai）", () => {
    expect(getUserTimezone().length).toBeGreaterThan(0);
  });
});

describe("getDefaultSendAt", () => {
  it("返回合法 datetime-local 字符串", () => {
    expect(getDefaultSendAt()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
  it("默认晚于当前时间", () => {
    expect(isAfterNow(getDefaultSendAt(new Date(2026, 0, 1)), new Date(2026, 0, 1))).toBe(true);
  });
});

describe("toUtcIso / toLocalInputValue 往返", () => {
  it("本地值转 UTC ISO 后能转回同一本地值", () => {
    const local = "2030-06-15T09:30";
    const utc = toUtcIso(local);
    expect(() => new Date(utc)).not.toThrow();
    expect(toLocalInputValue(utc)).toBe(local);
  });
});

describe("toLocalInputValue", () => {
  it("非法输入返回空串", () => {
    expect(toLocalInputValue("not-a-date")).toBe("");
  });
});

describe("isAfterNow", () => {
  it("未来时间返回 true，过去时间返回 false", () => {
    expect(isAfterNow("2030-01-01T00:00", new Date(2026, 0, 1))).toBe(true);
    expect(isAfterNow("2000-01-01T00:00", new Date(2026, 0, 1))).toBe(false);
  });
  it("非法输入返回 false", () => {
    expect(isAfterNow("")).toBe(false);
    expect(isAfterNow("bad")).toBe(false);
  });
});
