import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  doSetup,
  jsonInit,
  loginAndGetCookies,
  makeEnv,
  registerAndApprove,
  request,
} from "./helpers";

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

  it("cron 已尝试（attempts>0）的 scheduled 信不可再编辑", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(env, "/api/letters", jsonInit("POST", payload(), user));
    await request(env, `/api/letters/${created.body.id}/schedule`, {
      method: "POST",
      headers: user,
    });
    await env.DB.prepare(`UPDATE letters SET attempts = 1 WHERE id = ?`)
      .bind(created.body.id)
      .run();

    const updated = await request(
      env,
      `/api/letters/${created.body.id}`,
      jsonInit("PUT", payload({ title: "改不了" }), user),
    );
    expect(updated.status).toBe(409);
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
      `UPDATE letters SET status = 'failed', attempts = 3, last_error = 'boom' WHERE id = ?`,
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
      `UPDATE letters SET status = 'sent', is_public = 1, sent_at = ? WHERE id = ?`,
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
      `SELECT COUNT(*) as c FROM letter_recipients WHERE letter_id = ?`,
    )
      .bind(created.body.id)
      .first<{ c: number }>();
    expect(recipients!.c).toBe(0);
  });
});
