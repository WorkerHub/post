import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { applyResendEvent, verifyResendSignature } from "../services/resend";

// Resend webhook 入口：POST /api/resend/webhook（公开，无 admin 鉴权）。
// 身份验证只靠 Svix 签名（RESEND_WEBHOOK_SECRET），未配置或验签失败一律 fail closed 401；
// 查不到 email_id 的历史/重复/测试事件记日志返 200，避免 Resend 因连续 500 熔断关闭 webhook。

export const resendWebhookRoutes = new Hono<HonoEnv>();

resendWebhookRoutes.post("/", async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  // 验签必须用原始体，先 text() 再 JSON.parse。
  const rawBody = await c.req.text();
  const id = c.req.header("svix-id");
  const timestamp = c.req.header("svix-timestamp");
  const signature = c.req.header("svix-signature");

  if (
    !secret ||
    !(await verifyResendSignature(secret, { id, timestamp, signature }, rawBody))
  ) {
    return c.json({ error: "invalid signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }

  const obj = (body ?? {}) as Record<string, unknown>;
  const type = obj.type;
  const data = obj.data;
  if (
    typeof type !== "string" ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data)
  ) {
    return c.json({ error: "invalid payload" }, 400);
  }

  const outcome = await applyResendEvent(
    c.env,
    type,
    data as Record<string, unknown>,
  );
  if (outcome === "unknown") {
    const emailId = String((data as Record<string, unknown>).email_id ?? "");
    console.warn(`resend webhook: unknown email_id ${emailId}, type ${type}`);
  }

  return c.json({ success: true });
});
