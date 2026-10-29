import { setConnectFactory } from "./stubs/sockets";

// ─── Fake SMTP server over an in-memory duplex socket ────────────────────────

export interface FakeSmtpOptions {
  supportsStartTls?: boolean;
  rejectAuth?: boolean;
  rejectRecipient?: boolean;
  /** 覆盖 RCPT TO 的回复行（如 `452 4.7.0 too many messages`，造限流类临时拒收）。 */
  recipientReject?: string;
}

export class FakeSmtpServer {
  commands: string[] = [];
  connectCalls: { address: unknown; options: unknown }[] = [];
  message = "";
  startTlsUsed = false;
  authSeen: { user?: string; pass?: string; afterTls: boolean } | null = null;

  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
      this.push("220 fake.example.com ESMTP");
    },
  });
  private lineBuf = "";
  private inData = false;
  private pending: "user" | "pass" | null = null;

  constructor(private readonly opts: FakeSmtpOptions = {}) {}

  socket() {
    const self = this;
    return {
      readable: this.stream,
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          self.handleChunk(new TextDecoder().decode(chunk));
        },
      }),
      startTls() {
        self.startTlsUsed = true;
        return self.socket();
      },
      close: async () => {
        try {
          self.controller.close();
        } catch {
          /* already closed */
        }
      },
    };
  }

  install(): void {
    setConnectFactory((address, options) => {
      this.connectCalls.push({ address, options });
      return this.socket();
    });
  }

  private push(line: string): void {
    this.controller.enqueue(new TextEncoder().encode(`${line}\r\n`));
  }

  private handleChunk(text: string): void {
    this.lineBuf += text;
    let idx = this.lineBuf.indexOf("\r\n");
    while (idx >= 0) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 2);
      this.onLine(line);
      idx = this.lineBuf.indexOf("\r\n");
    }
  }

  private onLine(line: string): void {
    if (this.inData) {
      if (line === ".") {
        this.inData = false;
        this.push("250 2.0.0 queued");
      } else {
        this.message += `${line}\r\n`;
      }
      return;
    }

    if (this.pending === "user") {
      this.authSeen = {
        ...this.authSeen,
        user: Buffer.from(line, "base64").toString("utf8"),
        afterTls: this.startTlsUsed,
      };
      this.pending = "pass";
      this.push("334 UGFzc3dvcmQ6");
      return;
    }
    if (this.pending === "pass") {
      if (this.authSeen) {
        this.authSeen.pass = Buffer.from(line, "base64").toString("utf8");
        this.authSeen.afterTls = this.startTlsUsed;
      }
      this.pending = null;
      this.push(this.opts.rejectAuth ? "535 auth failed" : "235 2.7.0 ok");
      return;
    }

    this.commands.push(line);
    const upper = line.toUpperCase();

    if (upper.startsWith("EHLO")) {
      if (this.opts.supportsStartTls === false) {
        this.push("250 fake.example.com");
      } else {
        this.push("250-fake.example.com");
        this.push("250 STARTTLS");
      }
      return;
    }
    if (upper === "STARTTLS") {
      this.push(
        this.opts.supportsStartTls === false
          ? "500 5.5.1 unknown"
          : "220 go ahead",
      );
      return;
    }
    if (upper === "AUTH LOGIN") {
      this.pending = "user";
      this.push("334 VXNlcm5hbWU6");
      return;
    }
    if (upper.startsWith("MAIL FROM")) {
      this.push("250 2.1.0 ok");
      return;
    }
    if (upper.startsWith("RCPT TO")) {
      this.push(
        this.opts.recipientReject ??
          (this.opts.rejectRecipient ? "550 5.1.1 no such user" : "250 2.1.5 ok"),
      );
      return;
    }
    if (upper === "DATA") {
      this.inData = true;
      this.push("354 end with <CRLF>.<CRLF>");
      return;
    }
    if (upper === "QUIT") {
      this.push("221 bye");
      return;
    }
    this.push("500 5.5.1 unrecognized");
  }
}
