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

describe("contacts CRUD 与隔离（ONE-176）", () => {
  it("创建联系人：tags JSON 数组，返回解析后的数组", async () => {
    const { env, user } = await setupWithUser();
    const res = await request(
      env,
      "/api/contacts",
      jsonInit(
        "POST",
        { name: "妈妈", email: "mom@example.com", notes: "家里", tags: ["家人", "重要"] },
        user,
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "妈妈",
      email: "mom@example.com",
      notes: "家里",
      tags: ["家人", "重要"],
    });
  });

  it("(user_id, email) 唯一校验生效", async () => {
    const { env, user } = await setupWithUser();
    const first = await request(
      env,
      "/api/contacts",
      jsonInit("POST", { name: "A", email: "dup@example.com", tags: [] }, user),
    );
    expect(first.status).toBe(201);

    const dup = await request(
      env,
      "/api/contacts",
      jsonInit("POST", { name: "B", email: "DUP@example.com", tags: [] }, user),
    );
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("该邮箱已在联系人中");

    const second = await request(
      env,
      "/api/contacts",
      jsonInit("POST", { name: "C", email: "other@example.com", tags: [] }, user),
    );
    const upd = await request(
      env,
      `/api/contacts/${second.body.id}`,
      jsonInit("PUT", { name: "C", email: "dup@example.com", tags: [] }, user),
    );
    expect(upd.status).toBe(409);
  });

  it("搜索与标签筛选", async () => {
    const { env, user } = await setupWithUser();
    await request(
      env,
      "/api/contacts",
      jsonInit("POST", { name: "张三", email: "zhang@example.com", tags: ["同事"] }, user),
    );
    await request(
      env,
      "/api/contacts",
      jsonInit("POST", { name: "李四", email: "li@example.com", tags: ["家人"] }, user),
    );

    const byName = await request(env, "/api/contacts?q=张三", { headers: user });
    expect(byName.body.contacts).toHaveLength(1);
    expect(byName.body.contacts[0].name).toBe("张三");

    const byEmail = await request(env, "/api/contacts?q=li@example", { headers: user });
    expect(byEmail.body.contacts).toHaveLength(1);
    expect(byEmail.body.contacts[0].name).toBe("李四");

    const byTag = await request(env, "/api/contacts?tag=家人", { headers: user });
    expect(byTag.body.contacts).toHaveLength(1);
    expect(byTag.body.contacts[0].name).toBe("李四");
  });

  it("A 用户读不到 B 用户的联系人", async () => {
    const a = await setupWithUser("alice@example.com", "alicepass123");
    const b = await setupWithUser("bob@example.com", "bobpass123");

    const created = await request(
      a.env,
      "/api/contacts",
      jsonInit("POST", { name: "秘密", email: "secret@example.com", tags: [] }, a.user),
    );
    expect(created.status).toBe(201);

    const readB = await request(b.env, `/api/contacts/${created.body.id}`, {
      headers: b.user,
    });
    expect(readB.status).toBe(404);

    const putB = await request(
      b.env,
      `/api/contacts/${created.body.id}`,
      jsonInit("PUT", { name: "x", email: "secret@example.com", tags: [] }, b.user),
    );
    expect(putB.status).toBe(404);

    const delB = await request(b.env, `/api/contacts/${created.body.id}`, {
      method: "DELETE",
      headers: b.user,
    });
    expect(delB.status).toBe(404);

    const listB = await request(b.env, "/api/contacts", { headers: b.user });
    expect(listB.body.contacts).toHaveLength(0);
  });

  it("更新与删除", async () => {
    const { env, user } = await setupWithUser();
    const created = await request(
      env,
      "/api/contacts",
      jsonInit("POST", { name: "旧名", email: "upd@example.com", tags: [] }, user),
    );
    const updated = await request(
      env,
      `/api/contacts/${created.body.id}`,
      jsonInit(
        "PUT",
        { name: "新名", email: "upd@example.com", notes: "备注", tags: ["a", "a", "b"] },
        user,
      ),
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      name: "新名",
      email: "upd@example.com",
      notes: "备注",
      tags: ["a", "b"],
    });

    const del = await request(env, `/api/contacts/${created.body.id}`, {
      method: "DELETE",
      headers: user,
    });
    expect(del.status).toBe(200);
    const read = await request(env, `/api/contacts/${created.body.id}`, { headers: user });
    expect(read.status).toBe(404);
  });
});
