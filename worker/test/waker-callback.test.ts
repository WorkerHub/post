import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, setSendThrottleConfig } from "./helpers";
import { app } from "../src/index";
import { tables, type Env, type Letter } from "../src/types";
import { DUE_LETTERS_JOB, wakerExecutionsTable } from "../src/services/waker-callback";
import { CALLBACK_HEADERS, buildSignaturePayload } from "../src/waker";

// 回调入口的端到端断言（ONE-566）：走 someday 的真 Hono 路由 + 真 receiver + 真 D1 账本，
// 只有 SMTP 被替换。签名用**测试自生成的 key**在测试侧算（等价于平台侧 waker 的 sign.ts），
// 不接触任何生产密钥。

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("../src/services/email", () => ({ sendEmail: sendEmailMock }));

/** 测试签名密钥（自生成，仅本次单测用；绝不等于线上那把）。 */
const TEST_SIGNING_KEY = "test-waker-signing-key-for-unit-tests-only";
const JOB_ID = "job-due-letters-1";
const PROJECT_ID = "project-someday-test";
const PAST = "2026-01-01T00:00:00.000Z";

const encoder = new TextEncoder();

/** 平台侧签名（与 waker `src/callback/sign.ts` 同一份规范串）：`v2=<小写 hex>`。 */
async function signCallback(input: {
  secret: string;
  timestamp: string;
  executionId: string;
  jobId: string;
  body: string;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(buildSignaturePayload(input)),
  );
  const hex = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v2=${hex}`;
}

function callbackBody(
  executionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Date.now();
  return {
    protocolVersion: 2,
    executionId,
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    jobName: DUE_LETTERS_JOB,
    kind: "cron",
    trigger: "schedule",
    misfire: false,
    attempt: 0,
    scheduledFor: now,
    dispatchedAt: now,
    timeoutSeconds: 30,
    payload: {},
    ...overrides,
  };
}

interface CallbackOptions {
  executionId?: string;
  bodyOverrides?: Record<string, unknown>;
  secret?: string;
  /** 秒级时间戳字符串；默认当前时刻。 */
  timestamp?: string;
  /** 传 false 时完全不带签名头。 */
  sign?: boolean;
  /** 篡改：签名后用另一份 body 发送（模拟中间人改包）。 */
  tamperBeforeSend?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/** 发一次回调（默认合法签名）。 */
async function postCallback(env: Env, options: CallbackOptions = {}) {
  const executionId = options.executionId ?? `exec-${Math.random().toString(36).slice(2)}`;
  const body = callbackBody(executionId, options.bodyOverrides);
  const rawBody = JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    [CALLBACK_HEADERS.timestamp]: timestamp,
    [CALLBACK_HEADERS.executionId]: executionId,
    [CALLBACK_HEADERS.jobId]: String(body.jobId),
    [CALLBACK_HEADERS.projectId]: PROJECT_ID,
    [CALLBACK_HEADERS.attempt]: "0",
    [CALLBACK_HEADERS.protocolVersion]: "2",
  };
  if (options.sign !== false) {
    headers[CALLBACK_HEADERS.signature] = await signCallback({
      secret: options.secret ?? TEST_SIGNING_KEY,
      timestamp,
      executionId,
      jobId: String(body.jobId),
      body: rawBody,
    });
  }

  const sentBody =
    options.tamperBeforeSend === undefined
      ? rawBody
      : JSON.stringify(options.tamperBeforeSend(body));

  const res = await fetchCallback(env, sentBody, headers);
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, executionId };
}

async function fetchCallback(
  env: Env,
  rawBody: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request(
    "/_waker/execute",
    { method: "POST", headers, body: rawBody },
    env,
  );
}

// ─── 种子数据：一封到期信 + 收件人（口径同 scheduler.test.ts） ─────────────────

async function seedLetter(
  env: Env,
  recipients: { id: string; email: string; status?: string }[],
  letterOverrides: Partial<Letter> = {},
): Promise<string> {
  const T = tables(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${T.users} (id, email, password_hash, role, is_active, approval_status, created_at, updated_at)
     VALUES ('u1', 'a@b.c', 'h', 'user', 1, 'approved', '2026-01-01', '2026-01-01')`,
  ).run();
  const letterId = letterOverrides.id ?? "letter-1";
  await env.DB.prepare(
    `INSERT INTO ${T.letters} (id, user_id, title, body_html, body_json, send_at, timezone, status, is_public, attempts, created_at, updated_at)
     VALUES (?, 'u1', ?, ?, '', ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(
      letterId,
      letterOverrides.title ?? "我的信",
      letterOverrides.body_html ?? "<p>正文</p>",
      letterOverrides.send_at !== undefined ? letterOverrides.send_at : PAST,
      letterOverrides.timezone ?? "Asia/Shanghai",
      letterOverrides.status ?? "scheduled",
      letterOverrides.attempts ?? 0,
      letterOverrides.created_at ?? "2024-05-06T10:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )
    .run();

  for (const r of recipients) {
    await env.DB.prepare(
      `INSERT INTO ${T.letter_recipients} (id, letter_id, name, email, status, created_at)
       VALUES (?, ?, '', ?, ?, '2026-01-01')`,
    )
      .bind(r.id, letterId, r.email, r.status ?? "pending")
      .run();
  }
  return letterId;
}

async function letterStatus(env: Env, id: string): Promise<string | undefined> {
  const row = await env.DB.prepare(
    `SELECT status FROM ${tables(env).letters} WHERE id = ?`,
  )
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

async function ledgerRows(
  env: Env,
): Promise<{ execution_id: string; status: string; response_json: string | null }[]> {
  const res = await env.DB.prepare(
    `SELECT execution_id, status, response_json FROM ${wakerExecutionsTable(env)} ORDER BY claimed_at ASC`,
  ).all<{ execution_id: string; status: string; response_json: string | null }>();
  return res.results;
}

function signingEnv(overrides: Record<string, unknown> = {}): Env {
  return makeEnv({ WAKER_SIGNING_KEY: TEST_SIGNING_KEY, ...overrides });
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
});

describe("waker 回调：验签（未授权一律拒绝）", () => {
  it("不带签名头 → 400，且一封都不发", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const { status, body } = await postCallback(env, { sign: false });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_request");
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await letterStatus(env, "l1")).toBe("scheduled");
  });

  it("签名后改包（篡改 body）→ 401 invalid_signature，不投递", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const { status, body } = await postCallback(env, {
      tamperBeforeSend: (original) => ({ ...original, attempt: 1 }),
    });

    expect(status).toBe(401);
    expect(body.error.code).toBe("invalid_signature");
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await letterStatus(env, "l1")).toBe("scheduled");
  });

  it("用错 signing key 签名 → 401，且不写账本", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const { status } = await postCallback(env, { secret: "wrong-key-0102030405060708" });

    expect(status).toBe(401);
    expect(await ledgerRows(env)).toHaveLength(0);
  });

  it("时间戳超出 300s 窗口（重放）→ 401 stale_timestamp", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const stale = String(Math.floor(Date.now() / 1000) - 3_600);
    const { status, body } = await postCallback(env, { timestamp: stale });

    expect(status).toBe(401);
    expect(body.error.code).toBe("stale_timestamp");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("服务端没配 WAKER_SIGNING_KEY → 500 signing_key_missing（fail closed）", async () => {
    const env = makeEnv(); // 没有 WAKER_SIGNING_KEY
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const { status, body } = await postCallback(env);

    expect(status).toBe(500);
    expect(body.error.code).toBe("signing_key_missing");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("合法签名但任务名未声明 → 404 unknown_job", async () => {
    const env = signingEnv();
    const { status, body } = await postCallback(env, {
      bodyOverrides: { jobName: "not-a-declared-job" },
    });

    expect(status).toBe(404);
    expect(body.error.code).toBe("unknown_job");
  });
});

describe("waker 回调：同步执行 processDueLetters 并返回统计", () => {
  it("合法签名 → 200 + 统计，到期信真发出（await 到业务完成后才回 2xx）", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const { status, body, executionId } = await postCallback(env);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // 统计口径 = processDueLetters 的返回值
    expect(body.stats).toEqual({
      scanned: 1,
      claimed: 1,
      delivered: 1,
      partialFailed: 0,
      failed: 0,
      throttled: 0,
      deferred_by_cap: 0,
      paused_until: null,
    });
    // 业务真的跑完了：SMTP 被调用、信已置 sent（不是「先 2xx 再异步发」）
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][1].to).toBe("alice@example.com");
    expect(await letterStatus(env, "l1")).toBe("sent");

    // 账本记下这次执行
    const rows = await ledgerRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ execution_id: executionId, status: "succeeded" });
  });

  it("多封信 + 部分失败：统计与口一致（scanned / delivered / partialFailed）", async () => {
    const env = signingEnv();
    await setSendThrottleConfig(env);
    await seedLetter(env, [{ id: "r1", email: "good@example.com" }], { id: "l-ok" });
    await seedLetter(
      env,
      [
        { id: "r2", email: "bad@example.com" },
        { id: "r3", email: "good2@example.com" },
      ],
      { id: "l-partial" },
    );
    sendEmailMock.mockImplementation(async (_env: Env, o: { to: string }) =>
      o.to === "bad@example.com"
        ? { success: false, error: "SMTP error: expected 250, got 550" }
        : { success: true },
    );

    const { status, body } = await postCallback(env);

    expect(status).toBe(200);
    expect(body.stats).toEqual({
      scanned: 2,
      claimed: 2,
      delivered: 1,
      partialFailed: 1,
      failed: 0,
      throttled: 0,
      deferred_by_cap: 0,
      paused_until: null,
    });
    expect(await letterStatus(env, "l-ok")).toBe("sent");
    // 部分失败的信回到 scheduled，attempts+1（投递语义未改）
    expect(await letterStatus(env, "l-partial")).toBe("scheduled");
  });

  it("回调体里的 timeoutSeconds 决定本轮预算：预算不够时只发首封、其余顺延", async () => {
    const env = signingEnv();
    await setSendThrottleConfig(env);
    await seedLetter(env, [{ id: "r1", email: "first@example.com" }], { id: "l1" });
    await seedLetter(env, [{ id: "r2", email: "second@example.com" }], { id: "l2" });

    const { status, body } = await postCallback(env, {
      bodyOverrides: { timeoutSeconds: 1 },
    });

    expect(status).toBe(200);
    expect(body.stats.claimed).toBe(1);
    expect(body.stats.deferred_by_cap).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await letterStatus(env, "l2")).toBe("scheduled");
  });

  it("未到期的信不会被这次回调发出去（扫描口径不变）", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "future@example.com" }], {
      id: "l-future",
      send_at: "2999-01-01T00:00:00.000Z",
    });

    const { status, body } = await postCallback(env);

    expect(status).toBe(200);
    expect(body.stats.scanned).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("waker 回调：executionId 幂等（SDK D1 账本）", () => {
  it("同一次执行重投 → 200 duplicate + 回放首次统计，业务不重跑", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const first = await postCallback(env, { executionId: "exec-same" });
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    // 平台重试：同一个 executionId、同样的 body
    sendEmailMock.mockClear();
    const second = await postCallback(env, { executionId: "exec-same" });

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.stats).toEqual(first.body.stats);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await ledgerRows(env)).toHaveLength(1);
  });

  it("不同 executionId 各自跑一次（账本按执行而非按任务去重）", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    await postCallback(env, { executionId: "exec-a" });
    await postCallback(env, { executionId: "exec-b" });

    expect(await ledgerRows(env)).toHaveLength(2);
  });

  it("账本表名跟随 TABLE_PREFIX", async () => {
    const env = signingEnv({ TABLE_PREFIX: "kp_" });
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });

    const { status } = await postCallback(env);

    expect(status).toBe(200);
    expect(wakerExecutionsTable(env)).toBe("kp_waker_executions");
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM kp_waker_executions",
    ).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("waker 回调：失败回非 2xx（让平台重试）", () => {
  it("账本表不存在（未跑 schema_v2）→ 500，一封都不发", async () => {
    const env = signingEnv();
    await seedLetter(env, [{ id: "r1", email: "alice@example.com" }], { id: "l1" });
    await env.DB.prepare(`DROP TABLE ${wakerExecutionsTable(env)}`).run();

    const { status } = await postCallback(env);

    expect(status).toBe(500);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
