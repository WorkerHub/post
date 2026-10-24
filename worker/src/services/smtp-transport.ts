import { connect } from "cloudflare:sockets";

// Low-level SMTP transport for the system mail path (`services/email.ts`,
// configured globally via the `smtp_config` entry in `system_settings`).
// Ported 原样 from WorkerHub/eNotify 现行 main `smtp-transport.ts`
// (2026-10-24), with only project branding (EHLO / Message-ID domain) changed.
// 465 = implicit TLS, any other port = STARTTLS; if the server does not support
// STARTTLS and credentials are configured, plaintext delivery is refused.
// AUTH LOGIN, UTF-8 Base64.

export interface SmtpTransportConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  html: string;
  /** Envelope/header sender address. */
  from: string;
  /** Display name for the From header (optional). */
  fromName?: string;
}

export async function sendSmtpMessage(
  config: SmtpTransportConfig,
  message: SmtpMessage,
): Promise<{ success: boolean; error?: string }> {
  const from = message.from || "noreply@example.com";
  const fromName = (message.fromName || "post").replace(/[\r\n]/g, "");
  const isImplicitTls = config.port === 465;

  const socket: any = connect({ hostname: config.host, port: config.port }, {
    secureTransport: isImplicitTls ? "on" : "starttls",
  } as any);

  try {
    const session = new SmtpSession(socket);

    await session.expect(220);
    await session.cmd("EHLO post");
    await session.expect(250);

    if (!isImplicitTls) {
      const upgraded = await session.tryStartTls();
      if (!upgraded && config.username && config.password) {
        throw new Error(
          "Server does not support STARTTLS; refusing to send credentials in plaintext",
        );
      }
    }

    if (config.username && config.password) {
      await session.authLogin(config.username, config.password);
    }

    await session.sendMessage(
      from,
      fromName,
      message.to,
      message.subject,
      message.html,
    );
    await session.quit();

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `SMTP error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await socket.close().catch(() => {});
  }
}

export class SmtpSession {
  private buf = "";
  private readonly dec = new TextDecoder();
  private socket: any;
  private reader: ReadableStreamDefaultReader<any>;
  private writer: WritableStreamDefaultWriter<any>;

  constructor(socket: any) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async tryStartTls(): Promise<boolean> {
    await this.cmd("STARTTLS");
    const resp = await this.readResponse();
    if (resp.code !== 220) return false;

    this.reader.releaseLock();
    this.writer.releaseLock();

    const tls = this.socket.startTls();
    this.socket = tls;
    this.reader = tls.readable.getReader();
    this.writer = tls.writable.getWriter();
    this.buf = "";

    await this.cmd("EHLO post");
    await this.expect(250);
    return true;
  }

  async authLogin(user: string, pass: string): Promise<void> {
    await this.cmd("AUTH LOGIN");
    await this.expect(334);
    await this.cmd(btoa(user));
    await this.expect(334);
    await this.cmd(btoa(pass));
    await this.expect(235);
  }

  async sendMessage(
    from: string,
    fromName: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    await this.cmd(`MAIL FROM:<${from}>`);
    await this.expect(250);
    await this.cmd(`RCPT TO:<${to}>`);
    await this.expect(250);
    await this.cmd("DATA");
    await this.expect(354);

    const date = new Date().toUTCString();
    const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@post>`;
    const b64Body = wrapBase64(encodeUtf8Base64(html));
    const encodedSubject = `=?UTF-8?B?${encodeUtf8Base64(subject)}?=`;

    const message =
      `From: ${fromName} <${from}>\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodedSubject}\r\n` +
      `Date: ${date}\r\n` +
      `Message-ID: ${msgId}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      `${b64Body}\r\n` +
      `.\r\n`;

    await this.writer.write(new TextEncoder().encode(message));
    await this.expect(250);
  }

  async quit(): Promise<void> {
    await this.cmd("QUIT").catch(() => {});
  }

  async cmd(text: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(text + "\r\n"));
  }

  async expect(code: number): Promise<void> {
    const resp = await this.readResponse();
    if (resp.code !== code) {
      throw new Error(
        `SMTP: expected ${code}, got ${resp.code} — ${resp.message}`,
      );
    }
  }

  async readResponse(): Promise<{ code: number; message: string }> {
    const lines: string[] = [];
    for (;;) {
      while (!this.buf.includes("\r\n")) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("SMTP: connection closed unexpectedly");
        this.buf += this.dec.decode(value);
      }

      const eol = this.buf.indexOf("\r\n");
      const line = this.buf.slice(0, eol);
      this.buf = this.buf.slice(eol + 2);
      lines.push(line);

      // RFC 5321: last line has space at position 3; continuation lines have '-'
      if (line.length <= 3 || line[3] === " ") {
        const code = Number.parseInt(line.slice(0, 3), 10);
        if (Number.isNaN(code))
          throw new Error(`SMTP: invalid response line: ${line}`);
        return { code, message: lines.map((l) => l.slice(4)).join("\n") };
      }
    }
  }
}

export function encodeUtf8Base64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? b64;
}
