import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import {
  listUsers,
  findUserById,
  findUserByEmail,
  createUser,
  updateUser,
  deleteUser,
} from "../db/queries/users";
import { generateId, hashPassword } from "../core/auth";
import { revokeAllSessions } from "./auth";
import { publicUser } from "./auth";

// 管理员批准/禁用账号接口（SPEC §3，冻结契约：供管理后台 API（后端④）复用）。
// 会话吊销口径照 eNotify：角色变更 / 禁用 / 改密码 / 删除 → revokeAllSessions。

export const adminRoutes = new Hono<HonoEnv>();

adminRoutes.use("*", authMiddleware);
adminRoutes.use("*", adminMiddleware);

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

adminRoutes.get("/users", async (c) => {
  const users = await listUsers(c.env.DB);
  return c.json(users.map(publicUser));
});

// 批准待批准账号：pending → approved（幂等：已批准直接成功）
adminRoutes.put("/users/:uid/approve", async (c) => {
  const uid = c.req.param("uid");
  const user = await findUserById(c.env.DB, uid);
  if (!user) return c.json({ error: "User not found" }, 404);

  if (user.approval_status !== "approved") {
    await updateUser(c.env.DB, uid, { approval_status: "approved" });
  }
  return c.json({ success: true });
});

// 管理员直接建号（照 eNotify）：创建即 approved，角色默认 user
adminRoutes.post("/users", async (c) => {
  const body = await c.req.json<{
    email: string;
    password: string;
    role?: string;
  }>();

  const email = body.email?.trim().toLowerCase();
  if (!email || !body.password)
    return c.json({ error: "Email and password required" }, 400);
  if (!EMAIL_RE.test(email))
    return c.json({ error: "Invalid email format" }, 400);
  if (body.password.length < 8)
    return c.json({ error: "Password must be at least 8 characters" }, 400);

  const existing = await findUserByEmail(c.env.DB, email);
  if (existing) return c.json({ error: "Email already registered" }, 409);

  const id = generateId();
  const passwordHash = await hashPassword(body.password);
  const role = body.role === "admin" ? "admin" : "user";

  await createUser(c.env.DB, {
    id,
    email,
    password_hash: passwordHash,
    role,
    approval_status: "approved",
  });

  const user = await findUserById(c.env.DB, id);
  return c.json({ success: true, user: publicUser(user!) }, 201);
});

adminRoutes.get("/users/:uid", async (c) => {
  const uid = c.req.param("uid");
  const user = await findUserById(c.env.DB, uid);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json(publicUser(user));
});

// 角色变更 / 禁用启用 / 改邮箱 / 重置密码（照 eNotify PUT /users/:uid）
adminRoutes.put("/users/:uid", async (c) => {
  const uid = c.req.param("uid");
  const body = await c.req.json<{
    role?: string;
    is_active?: number | boolean;
    email?: string;
    password?: string;
  }>();

  const user = await findUserById(c.env.DB, uid);
  if (!user) return c.json({ error: "User not found" }, 404);

  if (uid === c.get("userId")) {
    if (body.role !== undefined && body.role !== "admin")
      return c.json({ error: "Cannot change your own role" }, 400);
    if (body.is_active !== undefined && !body.is_active)
      return c.json({ error: "Cannot disable yourself" }, 400);
  }

  const updates: Record<string, unknown> = {};
  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "user")
      return c.json({ error: "Invalid role" }, 400);
    updates.role = body.role;
  }
  if (body.is_active !== undefined)
    updates.is_active = body.is_active ? 1 : 0;
  if (body.email !== undefined) {
    const newEmail = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail))
      return c.json({ error: "Invalid email format" }, 400);
    const existing = await findUserByEmail(c.env.DB, newEmail);
    if (existing && existing.id !== uid)
      return c.json({ error: "Email already in use" }, 409);
    updates.email = newEmail;
  }
  if (body.password !== undefined) {
    if (body.password.length < 8)
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    updates.password_hash = await hashPassword(body.password);
  }

  await updateUser(c.env.DB, uid, updates);

  const roleChanged = updates.role !== undefined && updates.role !== user.role;
  const deactivated = updates.is_active === 0 && user.is_active;
  if (roleChanged || deactivated || updates.password_hash) {
    await revokeAllSessions(c.env.KV, uid);
  }
  return c.json({ success: true });
});

adminRoutes.delete("/users/:uid", async (c) => {
  const uid = c.req.param("uid");

  if (uid === c.get("userId")) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  const user = await findUserById(c.env.DB, uid);
  if (!user) return c.json({ error: "User not found" }, 404);

  await deleteUser(c.env.DB, uid);
  await revokeAllSessions(c.env.KV, uid);
  return c.json({ success: true });
});
