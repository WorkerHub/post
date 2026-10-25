import { describe, expect, it } from "vitest";
import { tables } from "../src/types";
import {
  cookieHeader,
  doSetup,
  jsonInit,
  loginAndGetCookies,
  makeEnv,
  registerAndApprove,
  request,
} from "./helpers";

async function setupWithUser() {
  const env = makeEnv();
  await doSetup(env, "admin@example.com", "adminpass123");
  const adminCookies = await loginAndGetCookies(env, "admin@example.com", "adminpass123");
  const adminHeader = cookieHeader(["access_token", adminCookies.access_token]);
  await registerAndApprove(env, adminHeader, "alice@example.com", "alicepass123");
  const userCookies = await loginAndGetCookies(env, "alice@example.com", "alicepass123");
  return { env, user: cookieHeader(["access_token", userCookies.access_token]) };
}

async function seedLetter(
  env: ReturnType<typeof makeEnv>,
  userId: string,
  overrides: {
    id: string;
    is_public: number;
    status: string;
    title?: string;
    body_html?: string;
    email?: string;
    sent_at?: string | null;
  },
) {
  const now = new Date().toISOString();
  const T = tables(env);
  await env.DB.prepare(
    `INSERT INTO ${T.letters} (id, user_id, title, body_html, body_json, send_at, timezone, status, is_public, attempts, last_error, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, 'Asia/Shanghai', ?, ?, 0, NULL, ?, ?, ?)`,
  )
    .bind(
      overrides.id,
      userId,
      overrides.title ?? "标题",
      overrides.body_html ?? "<p>正文</p>",
      now,
      overrides.status,
      overrides.is_public,
      overrides.sent_at ?? null,
      now,
      now,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO ${T.letter_recipients} (id, letter_id, contact_id, name, email, status, error, sent_at, created_at)
     VALUES (?, ?, NULL, '', ?, 'pending', NULL, NULL, ?)`,
  )
    .bind(`r-${overrides.id}`, overrides.id, overrides.email ?? "recipient@example.com", now)
    .run();
}

describe("公开信墙 API（ONE-176）", () => {
  it("未登录可达，只含 is_public=1（scheduled/sent），私有数据零出现", async () => {
    const { env, user } = await setupWithUser();
    const uid = (
      await env.DB.prepare(`SELECT id FROM ${tables(env).users} WHERE email = ?`)
        .bind("alice@example.com")
        .first<{ id: string }>()
    )!.id;

    // 一封公开 scheduled 信 + 一封公开 sent 信 + 一封私有 scheduled 信
    await seedLetter(env, uid, {
      id: "pub-scheduled",
      is_public: 1,
      status: "scheduled",
      title: "公开待寄",
      email: "recipient@example.com",
    });
    await seedLetter(env, uid, {
      id: "pub-sent",
      is_public: 1,
      status: "sent",
      title: "公开已寄",
      email: "recipient2@example.com",
      sent_at: new Date().toISOString(),
    });
    await seedLetter(env, uid, {
      id: "private",
      is_public: 0,
      status: "scheduled",
      title: "私有信标题",
      email: "private@example.com",
    });

    const res = await request(env, "/api/public/letters");
    expect(res.status).toBe(200);
    const body = res.body;

    // 只含 2 封公开信
    expect(body.letters).toHaveLength(2);
    const ids = body.letters.map((l: { id: string }) => l.id).sort();
    expect(ids).toEqual(["pub-scheduled", "pub-sent"]);

    // 私有信任何字段零出现（含响应原文）
    const rawText = JSON.stringify(body);
    expect(rawText).not.toContain("私有信标题");
    expect(rawText).not.toContain("private@example.com");

    // 邮箱打码：***@ 开头，绝不出现原始本地部分
    for (const letter of body.letters as Array<{ recipient_masked: string }>) {
      expect(letter.recipient_masked).toMatch(/^\*\*\*@/);
    }
    const pubScheduled = body.letters.find((l: { id: string }) => l.id === "pub-scheduled");
    expect(pubScheduled.recipient_masked).toBe("***@example.com");
    expect(pubScheduled.recipient_masked).not.toContain("recipient");

    // 无昵称显示名回空串（前端兜底「一位朋友」）
    expect(body.letters.every((l: { author_name: string }) => l.author_name === "")).toBe(true);

    // total_sent 统计全站已寄出（含私有 sent）
    const before = body.total_sent;
    await seedLetter(env, uid, {
      id: "private-sent",
      is_public: 0,
      status: "sent",
      title: "私有已寄",
      email: "private@example.com",
      sent_at: new Date().toISOString(),
    });
    const after = await request(env, "/api/public/letters");
    expect(after.body.total_sent).toBe(before + 1);
    expect(after.body.letters).toHaveLength(2); // 私有 sent 不上墙
  });

  it("展示时 body_html 再过白名单消毒，且响应可缓存", async () => {
    const { env, user } = await setupWithUser();
    const uid = (
      await env.DB.prepare(`SELECT id FROM ${tables(env).users} WHERE email = ?`)
        .bind("alice@example.com")
        .first<{ id: string }>()
    )!.id;

    await seedLetter(env, uid, {
      id: "pub-xss",
      is_public: 1,
      status: "sent",
      title: "消毒测试",
      body_html: '<p>安全正文</p><script>evil()</script><a href="javascript:alert(1)">x</a>',
      email: "recipient@example.com",
      sent_at: new Date().toISOString(),
    });

    const res = await request(env, "/api/public/letters");
    expect(res.status).toBe(200);
    const html = JSON.stringify(res.body);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("evil()");
    expect(html).not.toContain("javascript:");

    // 响应可缓存
    expect(res.res.headers.get("cache-control")).toContain("public");
    expect(res.res.headers.get("cache-control")).toContain("max-age");
  });

  it("昵称作为发信人显示名", async () => {
    const { env, user } = await setupWithUser();
    const uid = (
      await env.DB.prepare(`SELECT id FROM ${tables(env).users} WHERE email = ?`)
        .bind("alice@example.com")
        .first<{ id: string }>()
    )!.id;
    await env.DB.prepare(`UPDATE ${tables(env).users} SET display_name = ? WHERE id = ?`)
      .bind("小满", uid)
      .run();

    await seedLetter(env, uid, {
      id: "pub-named",
      is_public: 1,
      status: "sent",
      title: "有昵称",
      email: "recipient@example.com",
      sent_at: new Date().toISOString(),
    });

    const res = await request(env, "/api/public/letters");
    const letter = (res.body.letters as Array<{ id: string; author_name: string }>).find(
      (l) => l.id === "pub-named",
    );
    expect(letter!.author_name).toBe("小满");
  });
});
