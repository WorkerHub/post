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
  resolveSchema,
  SqliteD1,
} from "./helpers";
import { deleteLetter } from "../src/db/queries/letters";

const futureSendAt = () => new Date(Date.now() + 86400_000).toISOString();

function payload(overrides: Record<string, unknown> = {}) {
  return {
    title: "我的信",
    body_html: "<p>正文<script>evil()</script></p>",
    body_json: JSON.stringify({ type: "doc", content: [] }),
    send_at: futureSendAt(),
    timezone: "Asia/Shanghai",
    is_public: false,
    recipients: [{ name: "", email: "friend@example.com" }],
    ...overrides,
  };
}

async function setupWithUser(email = "alice@example.com", password = "alicepass123") {
  const env = makeEnv();
  await doSetup(env, "admin@example.com", "admin-pass-123");
  const adminCookies = await loginAndGetCookies(env, "admin@example.com", "admin-pass-123");
  const adminHeader = cookieHeader(["access_token", adminCookies.access_token]);
  await registerAndApprove(env, adminHeader, email, password);
  const userCookies = await loginAndGetCookies(env, email, password);
  return {
    env,
    admin: adminHeader,
    user: cookieHeader(["access_token", userCookies.access_token]),
  };
}

describe("letters CRUD 与状态流转（ONE-176）", () => {
  it("创建草稿：正文消毒、收件人落快照、默认 draft", async () => {
    const { env, user } = await setupWithUser();
    const res = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.is_public).toBe(false);
    expect(res.body.attempts).toBe(0);
    expect(res.body.body_html).not.toContain("<script>");
    expect(res.body.body_html).toContain("<p>正文</p>");
    expect(res.body.recipients).toEqual([
      { contact_id: null, name: "", email: "friend@example.com" },
    ]);
  });

  it("body_json 兼容对象输入（自动 JSON.stringify，不静默置空）", async () => {
    const { env, user } = await setupWithUser();
    const doc = { type: "doc", content: [{ type: "paragraph" }] };
    const res = await request(
      env,
      "/api/letters",
      jsonInit("POST", payload({ body_json: doc }), user),
    );
    expect(res.status).toBe(201);
    expect(res.body.body_json).toBe(JSON.stringify(doc));
  });

  it("列表只返回本人信件，非本人详情 404", async () => {
    const a = await setupWithUser("alice@example.com", "alicepass123");
    const b = await setupWithUser("bob@example.com", "bobpass123");

    const created = await request(a.env, "/api/letters", jsonInit("POST", payload(), a.user));
    expect(created.status).toBe(201);

    const readB = await request(b.env, `/api/letters/${created.body.id}`, { headers: b.user });
    expect(readB.status).toBe(404);
    const putB = await request(
      b.env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload(), b.user),
    );
    expect(putB.status).toBe(404);
    const delB = await request(b.env, `/api/letters/${created.body.id}`, {
      method: "DELETE",
      headers: b.user,
    });
    expect(delB.status).toBe(404);

    const listB = await request(b.env, "/api/letters", { headers: b.user });
    expect(listB.body.letters).toHaveLength(0);

    const readA = await request(a.env, `/api/letters/${created.body.id}`, { headers: a.user });
    expect(readA.status).toBe(200);
    expect(readA.body.id).toBe(created.body.id);
  });

  it("schedule：校验收件人非空与未来时间，draft → scheduled", async () => {
    const { env, user } = await setupWithUser();

    const empty = await request(
      env,
      "/api/letters",
      jsonInit("POST", payload({ recipients: [] }), user),
    );
    const schedEmpty = await request(
      env,
      `/api/letters/${empty.body.id}/schedule`,
      { method: "POST", headers: user },
    );
    expect(schedEmpty.status).toBe(400);
    expect(schedEmpty.body.error).toBe("请至少添加一位收件人");

    const past = await request(
      env,
      "/api/letters",
      jsonInit("POST", payload({ send_at: "2020-01-01T00:00:00.000Z" }), user),
    );
    const schedPast = await request(
      env,
      `/api/letters/${past.body.id}/schedule`,
      { method: "POST", headers: user },
    );
    expect(schedPast.status).toBe(400);
    expect(schedPast.body.error).toBe("送达时间须晚于当前时间");

    const ok = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    const schedOk = await request(env, `/api/letters/${ok.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });
    expect(schedOk.status).toBe(200);
    expect(schedOk.body.status).toBe("scheduled");
  });

  it("寄出前（attempts=0）可编辑内容与收件人，状态保持 scheduled", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });

    const updated = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit(
        "PUT",
        payload({ title: "新标题", recipients: [{ name: "", email: "other@example.com" }] }),
        user,
      ),
    );
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("新标题");
    expect(updated.body.status).toBe("scheduled");
    expect(updated.body.recipients).toEqual([
      { contact_id: null, name: "", email: "other@example.com" },
    ]);
  });

  it("scheduled 不变量：清空收件人/过去时间/null send_at 均被拒（防幽灵发送与死锁）", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });

    // 清空收件人仍 scheduled → 幽灵发送，拒绝
    const cleared = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload({ recipients: [] }), user),
    );
    expect(cleared.status).toBe(400);

    // 过去时间仍 scheduled → 提前触发，拒绝
    const past = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload({ send_at: "2020-01-01T00:00:00.000Z" }), user),
    );
    expect(past.status).toBe(400);

    // null send_at 仍 scheduled → 死锁，拒绝
    const clearedTime = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload({ send_at: null }), user),
    );
    expect(clearedTime.status).toBe(400);
  });

  it("PATCH 清空收件人或 send_at 时同样受 scheduled 不变量约束", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });

    const cleared = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PATCH", { recipients: [] }, user),
    );
    expect(cleared.status).toBe(400);

    const clearedTime = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PATCH", { send_at: null }, user),
    );
    expect(clearedTime.status).toBe(400);
  });

  it("已投递（有 sent 收件人）的 scheduled 信不可再编辑，attempts 无关", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });

    // 有一个收件人已 sent（部分投递），attempts 归零也无法编辑
    await env.DB.prepare(
      `UPDATE ${tables(env).letter_recipients} SET status = 'sent', sent_at = ? WHERE letter_id = ?`,
    )
      .bind(new Date().toISOString(), created.body.id)
      .run();

    const updated = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload({ title: "改不了" }), user),
    );
    expect(updated.status).toBe(409);

    const patched = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PATCH", { recipients: [{ name: "", email: "other@example.com" }] }, user),
    );
    expect(patched.status).toBe(409);
  });

  it("resend 后（有 sent 收件人）不可全量重写收件人，防重复投递", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    // 两个收件人：一个已 sent，一个 failed，信件置 failed
    await env.DB.prepare(
      `UPDATE ${tables(env).letter_recipients} SET status = 'sent', sent_at = ? WHERE letter_id = ?`,
    )
      .bind(new Date().toISOString(), created.body.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO ${tables(env).letter_recipients} (id, letter_id, contact_id, name, email, status, error, sent_at, created_at)
       VALUES ('r2', ?, NULL, '', 'second@example.com', 'failed', 'boom', NULL, '2026-01-01')`,
    )
      .bind(created.body.id)
      .run();
    await env.DB.prepare(`UPDATE ${tables(env).letters} SET status = 'failed', attempts = 3 WHERE id = ?`)
      .bind(created.body.id)
      .run();

    const resend = await request(env, `/api/letters/${created.body.id}/resend`, {
      method: "POST",
      headers: user,
    });
    expect(resend.status).toBe(200);
    expect(resend.body.status).toBe("scheduled");
    expect(resend.body.attempts).toBe(0);

    // 已有 sent 收件人，全量重写会被拒
    const updated = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit(
        "PUT",
        payload({ recipients: [{ name: "", email: "third@example.com" }] }),
        user,
      ),
    );
    expect(updated.status).toBe(409);

    // sent 收件人未被重写
    const recipients = await env.DB.prepare(
      `SELECT email, status FROM ${tables(env).letter_recipients} WHERE letter_id = ? ORDER BY id ASC`,
    )
      .bind(created.body.id)
      .all<{ email: string; status: string }>();
    const sent = recipients.results.filter((r) => r.status === "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].email).toBe("friend@example.com");
  });

  it("cancel：scheduled → cancelled；resend：failed → scheduled 且 attempts 归零", async () => {
    const { env, user } = await setupWithUser();

    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });
    const cancelled = await request(env, `/api/letters/${created.body.id}/cancel`, {
      method: "POST",
      headers: user,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");

    const failedLetter = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await env.DB.prepare(
      `UPDATE ${tables(env).letters} SET status = 'failed', attempts = 3, last_error = 'boom' WHERE id = ?`,
    )
      .bind(failedLetter.body.id)
      .run();
    const resend = await request(env, `/api/letters/${failedLetter.body.id}/resend`, {
      method: "POST",
      headers: user,
    });
    expect(resend.status).toBe(200);
    expect(resend.body.status).toBe("scheduled");
    expect(resend.body.attempts).toBe(0);
    expect(resend.body.last_error).toBeNull();
  });

  it("PATCH is_public 任何状态可切（sent 信关闭即时下墙）", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await env.DB.prepare(
      `UPDATE ${tables(env).letters} SET status = 'sent', is_public = 1, sent_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), created.body.id)
      .run();

    const patched = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PATCH", { is_public: false }, user),
    );
    expect(patched.status).toBe(200);
    expect(patched.body.is_public).toBe(false);
    expect(patched.body.status).toBe("sent");
  });

  it("联系人引用落快照：保存时读联系人 name/email，不随后续修改变化", async () => {
    const { env, user } = await setupWithUser();
    const contact = await request(
      env,
      "/api/contacts",
      jsonInit("POST", { name: "老朋友", email: "old@example.com", tags: [] }, user),
    );
    expect(contact.status).toBe(201);

    const created = await request(
      env,
      "/api/letters",
      jsonInit(
        "POST",
        payload({ recipients: [{ contact_id: contact.body.id, name: "", email: "" }] }),
        user,
      ),
    );
    expect(created.status).toBe(201);
    expect(created.body.recipients).toEqual([
      { contact_id: contact.body.id, name: "老朋友", email: "old@example.com" },
    ]);

    await request(
      env,
      `/api/contacts/${contact.body.id}`,
      jsonInit("PUT", { name: "改名了", email: "old@example.com", tags: [] }, user),
    );
    const reread = await request(env, `/api/letters/${created.body.id}`, { headers: user });
    expect(reread.body.recipients[0].name).toBe("老朋友");
  });

  it("删除信件连同收件人一起级联删除", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    const del = await request(env, `/api/letters/${created.body.id}`, {
      method: "DELETE",
      headers: user,
    });
    expect(del.status).toBe(200);

    const read = await request(env, `/api/letters/${created.body.id}`, { headers: user });
    expect(read.status).toBe(404);
    const recipients = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM ${tables(env).letter_recipients} WHERE letter_id = ?`,
    )
      .bind(created.body.id)
      .first<{ c: number }>();
    expect(recipients!.c).toBe(0);
  });

  it("deleteLetter 显式清理收件人：外键关闭时也无孤儿行", async () => {
    // 关闭 PRAGMA foreign_keys，模拟 D1 连接未开启级联时仍能清理干净
    const db = new SqliteD1(resolveSchema({ TABLE_PREFIX: "" }), false);
    await db.prepare(
      `INSERT INTO users (id, email, password_hash, role, is_active, approval_status, created_at, updated_at)
       VALUES ('u1', 'a@b.c', 'h', 'user', 1, 'approved', '2026-01-01', '2026-01-01')`,
    ).run();
    await db.prepare(
      `INSERT INTO letters (id, user_id, title, body_html, body_json, timezone, status, is_public, attempts, created_at, updated_at)
       VALUES ('l1', 'u1', 't', '', '', 'Asia/Shanghai', 'draft', 0, 0, '2026-01-01', '2026-01-01')`,
    ).run();
    await db.prepare(
      `INSERT INTO letter_recipients (id, letter_id, contact_id, name, email, status, created_at)
       VALUES ('r1', 'l1', NULL, '', 'a@b.c', 'pending', '2026-01-01')`,
    ).run();

    await deleteLetter(db as unknown as D1Database, "", "l1");

    const letterCount = await db
      .prepare(`SELECT COUNT(*) as c FROM letters WHERE id = 'l1'`)
      .first<{ c: number }>();
    const recipientCount = await db
      .prepare(`SELECT COUNT(*) as c FROM letter_recipients WHERE letter_id = 'l1'`)
      .first<{ c: number }>();
    expect(letterCount!.c).toBe(0);
    expect(recipientCount!.c).toBe(0);
  });

  it("draft 回退：scheduled → draft；已投递/非 scheduled 被拒", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });

    const reverted = await request(env, `/api/letters/${created.body.id}/draft`, {
      method: "POST",
      headers: user,
    });
    expect(reverted.status).toBe(200);
    expect(reverted.body.status).toBe("draft");

    // 草稿再回退幂等
    const again = await request(env, `/api/letters/${created.body.id}/draft`, {
      method: "POST",
      headers: user,
    });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("draft");

    // 已投递（sent）不可回退
    const s2 = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${s2.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });
    await env.DB.prepare(
      `UPDATE ${tables(env).letter_recipients} SET status = 'sent', sent_at = ? WHERE letter_id = ?`,
    )
      .bind(new Date().toISOString(), s2.body.id)
      .run();
    const blocked = await request(env, `/api/letters/${s2.body.id}/draft`, {
      method: "POST",
      headers: user,
    });
    expect(blocked.status).toBe(409);

    // failed 不可回退（走 resend）
    const failed = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await env.DB.prepare(`UPDATE ${tables(env).letters} SET status = 'failed' WHERE id = ?`)
      .bind(failed.body.id)
      .run();
    const failDraft = await request(env, `/api/letters/${failed.body.id}/draft`, {
      method: "POST",
      headers: user,
    });
    expect(failDraft.status).toBe(409);
  });

  it("cancelled 可回 draft 再编辑（前端③契约）", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });
    await request(env, `/api/letters/${created.body.id}/cancel`, {
      method: "POST",
      headers: user,
    });

    // PUT 保存已取消信件 → 回 draft
    const put = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload({ title: "重新编辑" }), user),
    );
    expect(put.status).toBe(200);
    expect(put.body.status).toBe("draft");
    expect(put.body.title).toBe("重新编辑");

    // 再定时可重新进入 scheduled
    const sched = await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });
    expect(sched.status).toBe(200);
    expect(sched.body.status).toBe("scheduled");
  });

  it("cancelled 的 /draft 回退与 PATCH 内容编辑也回 draft；纯 is_public 不变", async () => {
    const { env, user } = await setupWithUser();

    // POST /:id/draft 放行 cancelled
    const a = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${a.body.id}/schedule`, { method: "POST", headers: user });
    await request(env, `/api/letters/${a.body.id}/cancel`, { method: "POST", headers: user });
    const draftA = await request(env, `/api/letters/${a.body.id}/draft`, {
      method: "POST",
      headers: user,
    });
    expect(draftA.status).toBe(200);
    expect(draftA.body.status).toBe("draft");

    // PATCH 内容编辑回 draft
    const b = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${b.body.id}/schedule`, { method: "POST", headers: user });
    await request(env, `/api/letters/${b.body.id}/cancel`, { method: "POST", headers: user });
    const patchB = await request(
      env,
      `/api/letters/${b.body.id}`,
      jsonInit("PATCH", { title: "改标题" }, user),
    );
    expect(patchB.status).toBe(200);
    expect(patchB.body.status).toBe("draft");

    // 纯 is_public 开关不改状态（仍 cancelled）
    const c = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${c.body.id}/schedule`, { method: "POST", headers: user });
    await request(env, `/api/letters/${c.body.id}/cancel`, { method: "POST", headers: user });
    const patchC = await request(
      env,
      `/api/letters/${c.body.id}`,
      jsonInit("PATCH", { is_public: true }, user),
    );
    expect(patchC.status).toBe(200);
    expect(patchC.body.status).toBe("cancelled");
    expect(patchC.body.is_public).toBe(true);
  });

  it("cancelled 带已投递（sent）收件人：编辑/回退均 409（防重复投递）", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });
    // 模拟部分投递：该收件人已 sent
    await env.DB.prepare(
      `UPDATE ${tables(env).letter_recipients} SET status = 'sent', sent_at = ? WHERE letter_id = ?`,
    )
      .bind(new Date().toISOString(), created.body.id)
      .run();
    // 部分投递后用户 cancel → cancelled 且仍带 sent 收件人
    await request(env, `/api/letters/${created.body.id}/cancel`, {
      method: "POST",
      headers: user,
    });
    const afterCancel = await request(env, `/api/letters/${created.body.id}`, {
      headers: user,
    });
    expect(afterCancel.body.status).toBe("cancelled");

    // PUT 全量重写收件人 → 409
    const put = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload({ title: "篡改" }), user),
    );
    expect(put.status).toBe(409);

    // PATCH 内容编辑 → 409
    const patchContent = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PATCH", { title: "改标题" }, user),
    );
    expect(patchContent.status).toBe(409);

    // PATCH 收件人 → 409
    const patchRecipients = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PATCH", { recipients: [{ name: "", email: "other@example.com" }] }, user),
    );
    expect(patchRecipients.status).toBe(409);

    // POST /draft 回退 → 409
    const revert = await request(env, `/api/letters/${created.body.id}/draft`, {
      method: "POST",
      headers: user,
    });
    expect(revert.status).toBe(409);

    // sent 收件人快照未被抹除
    const recipients = await env.DB.prepare(
      `SELECT status FROM ${tables(env).letter_recipients} WHERE letter_id = ?`,
    )
      .bind(created.body.id)
      .all<{ status: string }>();
    expect(recipients.results).toHaveLength(1);
    expect(recipients.results[0].status).toBe("sent");
  });

  it("sending 中信不可删除", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await env.DB.prepare(`UPDATE ${tables(env).letters} SET status = 'sending' WHERE id = ?`)
      .bind(created.body.id)
      .run();

    const del = await request(env, `/api/letters/${created.body.id}`, {
      method: "DELETE",
      headers: user,
    });
    expect(del.status).toBe(409);
  });
});
