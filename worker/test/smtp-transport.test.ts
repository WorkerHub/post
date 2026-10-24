import { afterEach, describe, expect, it } from "vitest";
import {
  encodeUtf8Base64,
  sendSmtpMessage,
  wrapBase64,
} from "../src/services/smtp-transport";
import { setConnectFactory } from "./stubs/sockets";
import { FakeSmtpServer } from "./fake-smtp";

afterEach(() => {
  setConnectFactory(undefined);
});

const CONFIG = {
  host: "smtp.example.com",
  port: 587,
  username: "login@example.com",
  password: "s3cret-pass",
};

const MESSAGE = {
  to: "user@example.com",
  subject: "中文主题",
  html: "<p>你好，世界</p>",
  from: "notify@example.com",
  fromName: "时光邮局",
};

describe("sendSmtpMessage（465 隐式 TLS / STARTTLS / 拒绝明文）", () => {
  it("465 端口走隐式 TLS 且不发送 STARTTLS，AUTH 在 TLS 会话内", async () => {
    const server = new FakeSmtpServer();
    server.install();

    const result = await sendSmtpMessage({ ...CONFIG, port: 465 }, MESSAGE);

    expect(result).toEqual({ success: true });
    expect(server.connectCalls[0].address).toEqual({
      hostname: "smtp.example.com",
      port: 465,
    });
    expect(server.connectCalls[0].options).toEqual({ secureTransport: "on" });
    expect(server.commands.some((c) => c.toUpperCase() === "STARTTLS")).toBe(
      false,
    );
    expect(server.authSeen?.user).toBe("login@example.com");
    expect(server.authSeen?.pass).toBe("s3cret-pass");
    expect(server.message).toContain("From: 时光邮局 <notify@example.com>");
    expect(server.message).toContain("To: user@example.com");
  });

  it("587 端口协商 STARTTLS，凭证在 TLS 内发送", async () => {
    const server = new FakeSmtpServer();
    server.install();

    const result = await sendSmtpMessage(CONFIG, MESSAGE);

    expect(result).toEqual({ success: true });
    expect(server.connectCalls[0].options).toEqual({
      secureTransport: "starttls",
    });
    expect(server.startTlsUsed).toBe(true);
    expect(
      server.commands.filter((c) => c.toUpperCase().startsWith("EHLO")),
    ).toHaveLength(2);
    expect(server.authSeen?.afterTls).toBe(true);
  });

  it("服务器不支持 STARTTLS 且配了凭证时拒绝明文发送", async () => {
    const server = new FakeSmtpServer({ supportsStartTls: false });
    server.install();

    const result = await sendSmtpMessage(CONFIG, MESSAGE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("refusing to send credentials in plaintext");
    expect(server.commands).not.toContain("AUTH LOGIN");
    expect(server.message).toBe("");
  });

  it("无凭证时不要求 STARTTLS 且不 AUTH", async () => {
    const server = new FakeSmtpServer({ supportsStartTls: false });
    server.install();

    const result = await sendSmtpMessage(
      { ...CONFIG, username: "", password: "" },
      MESSAGE,
    );

    expect(result).toEqual({ success: true });
    expect(server.commands).not.toContain("AUTH LOGIN");
    expect(server.commands).toContain("MAIL FROM:<notify@example.com>");
  });

  it("SMTP 服务器拒绝时返回错误原文", async () => {
    const server = new FakeSmtpServer({ rejectRecipient: true });
    server.install();

    const result = await sendSmtpMessage(CONFIG, MESSAGE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("SMTP error");
    expect(result.error).toContain("550");
  });

  it("UTF-8 Base64 编码主题与正文", () => {
    const b64 = encodeUtf8Base64("中文主题");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("中文主题");
    expect(wrapBase64("A".repeat(80))).toBe(
      `${"A".repeat(76)}\r\n${"A".repeat(4)}`,
    );
  });
});
