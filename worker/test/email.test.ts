import { afterEach, describe, expect, it } from "vitest";
import { makeEnv } from "./helpers";
import { tables, type Env } from "../src/types";
import {
  buildMessageId,
  isValidEmail,
  isValidSmtpHost,
  parsePort,
  sendEmail,
} from "../src/services/email";
import { setConnectFactory } from "./stubs/sockets";
import { FakeSmtpServer } from "./fake-smtp";

async function setSmtpConfig(
  env: Env,
  config: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ${tables(env).system_settings} (key, value, updated_at) VALUES ('smtp_config', ?, '2026-01-01')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(config))
    .run();
}

const GOOD_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  username: "login@example.com",
  password: "s3cret-pass",
  from: "notify@example.com",
  from_name: "时光邮局",
};

const OPTIONS = {
  to: "user@example.com",
  subject: "主题",
  html: "<p>正文</p>",
};

afterEach(() => {
  setConnectFactory(undefined);
});

describe("sendEmail 输入校验（照 email-notify.ts）", () => {
  it("拒绝非法收件人（注入/格式错误），不建立连接", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, GOOD_CONFIG);
    setConnectFactory(() => {
      throw new Error("must not connect");
    });

    for (const to of [
      "",
      "not-an-email",
      "user@example.com\r\nBcc: victim@example.com",
      "a@b.com,eve@b.com",
    ]) {
      const result = await sendEmail(env, { ...OPTIONS, to });
      expect(result).toEqual({
        success: false,
        error: "Invalid recipient email address",
      });
    }
  });

  it("未配置 smtp_config 时报错", async () => {
    const env = makeEnv();
    const result = await sendEmail(env, OPTIONS);
    expect(result).toEqual({ success: false, error: "SMTP not configured" });
  });

  it("smtp_config JSON 非法时报错", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO ${tables(env).system_settings} (key, value, updated_at) VALUES ('smtp_config', 'not-json', '2026-01-01')`,
    ).run();
    expect(await sendEmail(env, OPTIONS)).toEqual({
      success: false,
      error: "Invalid SMTP config",
    });
  });

  it("校验 host / port", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, { ...GOOD_CONFIG, host: "" });
    expect(await sendEmail(env, OPTIONS)).toEqual({
      success: false,
      error: "SMTP host not configured",
    });

    await setSmtpConfig(env, {
      ...GOOD_CONFIG,
      host: "smtp.example.com\r\nX: 1",
    });
    expect(await sendEmail(env, OPTIONS)).toEqual({
      success: false,
      error: "Invalid SMTP host",
    });

    await setSmtpConfig(env, { ...GOOD_CONFIG, port: "abc" });
    expect(await sendEmail(env, OPTIONS)).toEqual({
      success: false,
      error: "Invalid SMTP port",
    });
  });

  it("校验发件人（缺失/注入）", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, { ...GOOD_CONFIG, from: "", username: "" });
    expect(await sendEmail(env, OPTIONS)).toEqual({
      success: false,
      error: "SMTP sender not configured",
    });

    await setSmtpConfig(env, {
      ...GOOD_CONFIG,
      from: "notify@example.com\r\nBcc: victim@example.com",
    });
    expect(await sendEmail(env, OPTIONS)).toEqual({
      success: false,
      error: "Invalid SMTP sender address",
    });
  });

  it("主题 CRLF 被剥除（不会注入独立头）", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, GOOD_CONFIG);
    const server = new FakeSmtpServer();
    server.install();

    const result = await sendEmail(env, {
      ...OPTIONS,
      subject: "标题\r\nBcc: victim@example.com",
    });

    expect(result.success).toBe(true);
    const subjectLine = server.message
      .split("\r\n")
      .find((l) => l.startsWith("Subject:"));
    const b64 = subjectLine!
      .replace(/^Subject: =\?UTF-8\?B\?/, "")
      .replace(/\?=$/, "");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).not.toContain("\r");
    expect(decoded).not.toContain("\n");
    expect(decoded).toContain("标题");
    expect(decoded).toContain("Bcc: victim@example.com");
  });

  it("success 路径：字符串 port 转数字，465 走隐式 TLS", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, { ...GOOD_CONFIG, port: "465" });
    const server = new FakeSmtpServer();
    server.install();

    const result = await sendEmail(env, OPTIONS);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeTruthy();
    expect(server.connectCalls[0].address).toEqual({
      hostname: "smtp.example.com",
      port: 465,
    });
    expect(server.connectCalls[0].options).toEqual({ secureTransport: "on" });
    expect(server.message).toContain("From: 时光邮局 <notify@example.com>");
  });
});

describe("校验工具函数", () => {
  it("isValidEmail", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("a@b.com\r\nX: 1")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
  });

  it("isValidSmtpHost 接受主机名/IPv4/带方括号 IPv6，拒绝注入", () => {
    for (const ok of ["smtp.example.com", "192.0.2.10", "[2001:db8::1]"]) {
      expect(isValidSmtpHost(ok)).toBe(true);
    }
    for (const bad of [
      "smtp.example.com\r\nX-Injected: 1",
      "smtp.example.com/evil",
      "user@smtp.example.com",
      "smtp example com",
    ]) {
      expect(isValidSmtpHost(bad)).toBe(false);
    }
  });

  it("parsePort 字符串/数字均可，非法返回 null", () => {
    expect(parsePort("587")).toBe(587);
    expect(parsePort(465)).toBe(465);
    expect(parsePort("")).toBeNull();
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("0")).toBeNull();
    expect(parsePort("70000")).toBeNull();
    expect(parsePort(undefined)).toBeNull();
  });
});

// ─── 发信节流补遗 §3.3：每收件人唯一 Message-ID ─────────────────────────────

describe("Message-ID（节流补遗 §3.3）", () => {
  it("带 letterId/recipientId 时按 <sr.{letter}.{recipient}.{rand}@{From 域名}> 生成并带回", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, GOOD_CONFIG);
    const server = new FakeSmtpServer();
    server.install();

    const result = await sendEmail(env, {
      ...OPTIONS,
      letterId: "letter-1",
      recipientId: "rec-1",
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(
      /^<sr\.letter-1\.rec-1\.[a-z0-9]+@example\.com>$/,
    );
    expect(server.message).toContain(`Message-ID: ${result.messageId}`);
    expect(server.message).toContain("X-Someday-Letter-Id: letter-1");
  });

  it("同一封信不同收件人的副本 Message-ID 不同", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, GOOD_CONFIG);
    const server = new FakeSmtpServer();
    server.install();

    const first = await sendEmail(env, { ...OPTIONS, letterId: "l1", recipientId: "r1" });
    const second = await sendEmail(env, { ...OPTIONS, letterId: "l1", recipientId: "r2" });

    expect(first.messageId).not.toBe(second.messageId);
  });

  it("无信件的调用（管理员测试邮件）用通用形态、不带 X-Someday 头", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, GOOD_CONFIG);
    const server = new FakeSmtpServer();
    server.install();

    const result = await sendEmail(env, OPTIONS);

    expect(result.messageId).toMatch(/^<[^@]+@example\.com>$/);
    expect(server.message).not.toContain("X-Someday-Letter-Id");
  });

  it("buildMessageId：id 含非法字符时退回通用形态（防头注入）", () => {
    expect(buildMessageId("a@b.com", "l1", "r1")).toMatch(/^<sr\.l1\.r1\.[a-z0-9]+@b\.com>$/);
    expect(buildMessageId("a@b.com", "l\r\n1", "r1")).toMatch(/^<[^@]+@b\.com>$/);
    expect(buildMessageId("a@b.com")).toMatch(/^<[^@]+@b\.com>$/);
  });

  it("限流类拒收（452）把 code/response 带到上层，供分类使用", async () => {
    const env = makeEnv();
    await setSmtpConfig(env, GOOD_CONFIG);
    const server = new FakeSmtpServer({ recipientReject: "452 4.7.0 too many messages" });
    server.install();

    const result = await sendEmail(env, OPTIONS);

    expect(result.success).toBe(false);
    expect(result.code).toBe(452);
    expect(result.response).toBe("4.7.0 too many messages");
    expect(result.messageId).toBeUndefined();
  });
});
