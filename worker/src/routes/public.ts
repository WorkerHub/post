import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getTablePrefix } from "../types";
import { countSentLetters, listPublicLetters } from "../db/queries/letters";
import { sanitizeBodyHtml } from "../services/sanitize";

// 公开信墙（SPEC §6，ONE-176 冻结契约）：
// GET /api/public/letters → { total_sent, letters: [...] }，未登录可达，仅 is_public=1（scheduled/sent）。
// 安全红线：私有信（is_public=0）任何字段零出现；收件邮箱服务端打码；body_html 展示时再过白名单消毒。

export const publicRoutes = new Hono<HonoEnv>();

/** 邮箱打码：***@gmail.com（域名保留，本地部分全掩）。 */
function maskEmail(email: string | null): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `***@${email.slice(at + 1)}`;
}

publicRoutes.get("/letters", async (c) => {
  const prefix = getTablePrefix(c.env);
  const [rows, totalSent] = await Promise.all([
    listPublicLetters(c.env.DB, prefix),
    countSentLetters(c.env.DB, prefix),
  ]);

  // 响应可缓存（短 TTL，保证关公开开关后能较快下墙）。
  c.header("Cache-Control", "public, max-age=30, s-maxage=60");

  return c.json({
    total_sent: totalSent,
    letters: rows.map((r) => ({
      id: r.id,
      title: r.title,
      body_html: sanitizeBodyHtml(r.body_html),
      send_at: r.send_at,
      sent_at: r.sent_at,
      created_at: r.created_at,
      recipient_masked: maskEmail(r.recipient_email),
      author_name: r.author_name || "",
    })),
  });
});
