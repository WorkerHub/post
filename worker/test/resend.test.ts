import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, setRawSetting, doSetup, loginAndGetCookies, cookieHeader, jsonInit, request } from "./helpers";
import { tables, type Env } from "../src/types";
import {
  applyResendEvent,
  sendResendEmail,
  verifyResendSignature,
  MAIL_CHANNEL_KEY,
  RESEND_TOKENS_KEY,
} from "../src/services/resend";
import { classifySendFailure } from "../src/services/send-throttle";

const RESEND_ID = "49a7609c-1234-5678-9abc-def012345678";

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 造一个「已 sent 且 message_id=resend id」的收件人，供 webhook 反查。 */
async function seedSentRecipient(
  env: Env,
  messageId: string,
  email = "friend@example.com",
): Promise<{ letterId: string; recipientId: string }> {
  const T = tables(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${T.users} (id, email, password_hash, role, is_active, approval_status, created_at, updated_at)
     VALUES ('u1', 'a@b.c', 'h', 'user', 1, 'approved', '2026-01-01', '2026-01-01')`,
  ).run();
  const letterId = "letter-1";
  await env.DB.prepare(
    `INSERT INTO ${T.letters} (id, user_id, title, body_html, body_json, send_at, timezone, status, is_public, attempts, created_at, updated_at)
     VALUES ('letter-1', 'u1', 't', '', '', NULL, 'Asia/Shanghai', 'sent', 0, 0, '2026-01-01', '2026-01-01')`,
  ).run();
  const recipientId = "rec-1";
  await env.DB.prepare(
    `INSERT INTO ${T.letter_recipients} (id, letter_id, name, email, status, error, sent_at, message_id, created_at)
     VALUES ('rec-1', 'letter-1', '', ?, 'sent', NULL, '2026-01-01', ?, '2026-01-01')`,
  )
    .bind(email, messageId)
    .run();
  return { letterId, recipientId };
}

async function recipientOf(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM ${tables(env).letter_recipients} WHERE id = ?`)
    .bind(id)
    .first<{ status: string; error: string | null }>();
}

const TEST_SECRET = "whsec_" + btoa("test-secret-0123456789abcdef");

/** 测试侧按 Svix 规范造一条合法签名（与实现同算法，用于正例）。 */
async function signSvix(
  secret: string,
  rawBody: string,
  id: string,
  timestamp: string,
): Promise<string> {
  const keyBytes = Uint8Array.from(atob(secret.slice("whsec_".length)), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  let bin = "";
  new Uint8Array(sig).forEach((b) => (bin += String.fromCharCode(b)));
  return `v1,${btoa(bin)}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendResendEmail（Resend API 直连）", () => {
  async function configuredEnv(): Promise<Env> {
    const env = makeEnv();
    await setRawSetting(env, RESEND_TOKENS_KEY, JSON.stringify({ "example.com": "re_token" }));
    // 发件域取 smtp_config.from 的域名
    await setRawSetting(env, "smtp_config", JSON.stringify({ from: "notify@example.com", from_name: "时光邮局" }));
    return env;
  }

  it("成功：返回 Resend 邮件 id 作为 messageId，标记 http 通道", async () => {
    const env = await configuredEnv();
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: RESEND_ID }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendResendEmail(env, {
      to: "friend@example.com",
      subject: "标题",
      html: "<p>正文</p>",
      from: "notify@example.com",
      fromName: "时光邮局",
      letterId: "letter-1",
    });

    expect(result.success).toBe(true);
    expect(result.http).toBe(true);
    expect(result.messageId).toBe(RESEND_ID);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body as string);
    expect(payload.from).toBe("时光邮局 <notify@example.com>");
    expect(payload.to).toEqual(["friend@example.com"]);
    expect(payload.headers).toEqual({ "X-Someday-Letter-Id": "letter-1" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_token");
  });

  it("发件域无 token 时失败（不回退 SMTP）", async () => {
    const env = makeEnv();
    await setRawSetting(env, RESEND_TOKENS_KEY, JSON.stringify({ "other.com": "re_token" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendResendEmail(env, {
      to: "friend@example.com",
      subject: "s",
      html: "<p></p>",
      from: "notify@example.com",
    });

    expect(result.success).toBe(false);
    expect(result.http).toBe(true);
    expect(result.error).toBe("Resend not configured for domain example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("429/400/500 带回 HTTP 状态码供分类", async () => {
    const env = await configuredEnv();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(429, { message: "rate limited" })));
    let result = await sendResendEmail(env, { to: "a@b.c", subject: "s", html: "<p></p>", from: "notify@example.com" });
    expect(result.success).toBe(false);
    expect(result.code).toBe(429);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(400, { message: "domain not verified" })));
    result = await sendResendEmail(env, { to: "a@b.c", subject: "s", html: "<p></p>", from: "notify@example.com" });
    expect(result.code).toBe(400);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(500, { message: "internal" })));
    result = await sendResendEmail(env, { to: "a@b.c", subject: "s", html: "<p></p>", from: "notify@example.com" });
    expect(result.code).toBe(500);
  });
});

describe("verifyResendSignature（Svix）", () => {
  const rawBody = '{"type":"email.delivered","data":{"email_id":"x"}}';
  const id = "msg_123";
  const timestamp = "1700000000";

  it("合法签名通过，篡改/错密钥/缺头/坏密钥拒绝", async () => {
    const good = await signSvix(TEST_SECRET, rawBody, id, timestamp);
    expect(await verifyResendSignature(TEST_SECRET, { id, timestamp, signature: good }, rawBody)).toBe(true);

    const wrongSecret = "whsec_" + btoa("another-secret-0123456789abcdef");
    expect(await verifyResendSignature(wrongSecret, { id, timestamp, signature: good }, rawBody)).toBe(false);

    expect(await verifyResendSignature(TEST_SECRET, { id: null, timestamp, signature: good }, rawBody)).toBe(false);
    expect(await verifyResendSignature("not-a-secret", { id, timestamp, signature: good }, rawBody)).toBe(false);

    const tampered = await signSvix(TEST_SECRET, rawBody + " ", id, timestamp);
    expect(await verifyResendSignature(TEST_SECRET, { id, timestamp, signature: tampered }, rawBody)).toBe(false);
  });
});

describe("classifySendFailure 的 HTTP 通道分类", () => {
  it("429 → throttle；4xx → permanent；5xx → other；SMTP 4xx 不受影响", () => {
    expect(classifySendFailure({ http: true, code: 429, text: "rate limited" }).kind).toBe("throttle");
    expect(classifySendFailure({ http: true, code: 400, text: "bad" }).kind).toBe("permanent");
    expect(classifySendFailure({ http: true, code: 500, text: "boom" }).kind).toBe("other");
    // SMTP 通道（无 http 标记）的 4xx 不落入 permanent（保持限流补遗语义）
    expect(classifySendFailure({ code: 454, text: "SMTP error: got 454" }).kind).toBe("other");
  });
});

describe("applyResendEvent（事件回写）", () => {
  it("bounced 把 sent 收件人翻 failed 并记原因；delivered 保持 sent；未知 id 返回 unknown", async () => {
    const env = makeEnv();
    const { recipientId } = await seedSentRecipient(env, RESEND_ID);

    const delivered = await applyResendEvent(env, "email.delivered", { email_id: RESEND_ID });
    expect(delivered).toBe("noop");
    expect((await recipientOf(env, recipientId))!.status).toBe("sent");

    const bounced = await applyResendEvent(env, "email.bounced", {
      email_id: RESEND_ID,
      bounce: { message: "550 5.1.1 user unknown", type: "hard_bounce" },
    });
    expect(bounced).toBe("applied");
    const after = await recipientOf(env, recipientId);
    expect(after!.status).toBe("failed");
    expect(after!.error).toContain("550 5.1.1 user unknown");

    // 幂等：再发一次 bounced 不重复改写（已非 sent）
    expect(await applyResendEvent(env, "email.bounced", { email_id: RESEND_ID })).toBe("noop");

    expect(await applyResendEvent(env, "email.delivered", { email_id: "unknown-id" })).toBe("unknown");
  });
});

describe("管理后台 Resend 渠道配置", () => {
  async function adminEnv() {
    const env = makeEnv();
    await doSetup(env, "admin@example.com", "{{SECRET_omvdiz7o}}");
    const cookies = await loginAndGetCookies(env, "admin@example.com", "{{SECRET_omvdiz7o}}");
    return { env, admin: cookieHeader(["access_token", cookies.access_token]) };
  }

  it("PUT 保存渠道与 token，GET 脱敏返回（token 空串 + tokens_set 标记）", async () => {
    const { env, admin } = await adminEnv();
    const put = await request(
      env,
      "/api/admin/settings/resend",
      jsonInit("PUT", { channel: "resend", resend_tokens: { "example.com": "re_secret_token" } }, admin),
    );
    expect(put.status).toBe(200);
    expect(put.body.channel).toBe("resend");
    expect(put.body.resend_tokens).toEqual({ "example.com": "" });
    expect(put.body.tokens_set).toEqual({ "example.com": true });

    const get = await request(env, "/api/admin/settings/resend", { headers: admin });
    expect(JSON.stringify(get.body)).not.toContain("re_secret_token");
    expect(get.body.channel).toBe("resend");
    expect(get.body.tokens_set["example.com"]).toBe(true);

    const raw = await env.DB.prepare(`SELECT value FROM ${tables(env).system_settings} WHERE key = ?`)
      .bind(RESEND_TOKENS_KEY)
      .first<{ value: string }>();
    expect(JSON.parse(raw!.value)["example.com"]).toBe("re_secret_token");
    const channelRaw = await env.DB.prepare(`SELECT value FROM ${tables(env).system_settings} WHERE key = ?`)
      .bind(MAIL_CHANNEL_KEY)
      .first<{ value: string }>();
    expect(channelRaw!.value).toBe("resend");
  });

  it("非法渠道 400；token 留空不改", async () => {
    const { env, admin } = await adminEnv();
    const bad = await request(env, "/api/admin/settings/resend", jsonInit("PUT", { channel: "other" }, admin));
    expect(bad.status).toBe(400);

    await request(env, "/api/admin/settings/resend", jsonInit("PUT", { channel: "resend", resend_tokens: { "example.com": "re_token" } }, admin));
    // 只改渠道，token 留空
    await request(env, "/api/admin/settings/resend", jsonInit("PUT", { channel: "smtp", resend_tokens: { "example.com": "" } }, admin));
    const raw = await env.DB.prepare(`SELECT value FROM ${tables(env).system_settings} WHERE key = ?`)
      .bind(RESEND_TOKENS_KEY)
      .first<{ value: string }>();
    expect(JSON.parse(raw!.value)["example.com"]).toBe("re_token");
  });
});

describe("Resend webhook 路由（POST /api/resend/webhook）", () => {
  it("验签通过时回写状态；密钥缺失或验签失败 fail closed 401", async () => {
    const env = makeEnv();
    await seedSentRecipient(env, RESEND_ID);
    env.RESEND_WEBHOOK_SECRET = TEST_SECRET;

    const body = JSON.stringify({
      type: "email.bounced",
      data: { email_id: RESEND_ID, bounce: { message: "550 no such user", type: "hard_bounce" } },
    });
    const id = "msg_1";
    const timestamp = "1700000000";
    const signature = await signSvix(TEST_SECRET, body, id, timestamp);

    const res = await request(env, "/api/resend/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      },
      body,
    });
    expect(res.status).toBe(200);
    const recipient = await env.DB.prepare(`SELECT status FROM ${tables(env).letter_recipients} WHERE id = 'rec-1'`)
      .first<{ status: string }>();
    expect(recipient!.status).toBe("failed");

    // 篡改体 → 401
    const bad = await request(env, "/api/resend/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      },
      body: body + " ",
    });
    expect(bad.status).toBe(401);

    // 未配置密钥 → 401（fail closed）
    const env2 = makeEnv();
    await seedSentRecipient(env2, RESEND_ID);
    const res2 = await request(env2, "/api/resend/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res2.status).toBe(401);
  });
});
