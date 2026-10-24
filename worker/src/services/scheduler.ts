import type { Env, Letter, LetterRecipient } from "../types";
import { sendEmail } from "./email";
import { sanitizeBodyHtml } from "./sanitize";

// cron 调度与逐收件人投递（SPEC §5）。
// 防重复用 D1 状态抢占（不用 KV dedupe）：
//   UPDATE letters SET status='sending' WHERE id=? AND status='scheduled'
// 影响行数为 1 才发送；同一封信被并发 cron 抢占时只有一方会拿到行数=1。
// 逐收件人单独发一封（独立 RCPT，收件人之间互不可见）；全部成功 → letters 置 sent；
// 部分失败 → 失败者记录 error，letters attempts+1 回到 scheduled，下个周期只补发失败收件人；
// attempts 达 3 次仍失败 → letters 置 failed、last_error 汇总。

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 50;

export interface DeliveryStats {
  scanned: number;
  delivered: number;
  partialFailed: number;
  gaveUp: number;
}

export async function processDueLetters(env: Env): Promise<DeliveryStats> {
  const now = new Date().toISOString();
  const stats: DeliveryStats = {
    scanned: 0,
    delivered: 0,
    partialFailed: 0,
    gaveUp: 0,
  };

  const due = await env.DB.prepare(
    `SELECT id FROM letters
     WHERE status = 'scheduled' AND send_at IS NOT NULL AND send_at <= ?
     ORDER BY send_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, BATCH_SIZE)
    .all<{ id: string }>();

  stats.scanned = due.results.length;

  for (const { id } of due.results) {
    try {
      const outcome = await deliverLetter(env, id);
      if (outcome === "delivered") stats.delivered++;
      else if (outcome === "partial") stats.partialFailed++;
      else if (outcome === "gaveUp") stats.gaveUp++;
      // "skipped"/"error" 不计入投递结果
    } catch (err) {
      console.error(`Delivery error for letter ${id}:`, err);
    }
  }

  return stats;
}

type DeliverOutcome =
  | "delivered"
  | "partial"
  | "gaveUp"
  | "skipped"
  | "error";

export async function deliverLetter(
  env: Env,
  letterId: string,
): Promise<DeliverOutcome> {
  const now = new Date().toISOString();

  // 状态抢占：只有把 scheduled → sending 的这一次更新生效（changes=1）才继续发送。
  const claim = await env.DB.prepare(
    `UPDATE letters SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'scheduled'`,
  )
    .bind(now, letterId)
    .run();

  if (!claim.meta?.changes || claim.meta.changes !== 1) {
    return "skipped";
  }

  try {
    return await deliverClaimedLetter(env, letterId);
  } catch (err) {
    // 意外异常：把信退回 scheduled，避免永久卡在 sending（attempts 不变，下个周期重试）。
    console.error(`Delivery error for letter ${letterId}:`, err);
    try {
      await env.DB.prepare(
        `UPDATE letters SET status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'sending'`,
      )
        .bind(new Date().toISOString(), letterId)
        .run();
    } catch {
      /* DB 本身不可用则无能为力 */
    }
    return "error";
  }
}

async function deliverClaimedLetter(
  env: Env,
  letterId: string,
): Promise<DeliverOutcome> {
  const letter = await env.DB.prepare(`SELECT * FROM letters WHERE id = ?`)
    .bind(letterId)
    .first<Letter>();
  if (!letter) return "error";

  const recipients = await env.DB.prepare(
    `SELECT * FROM letter_recipients WHERE letter_id = ? ORDER BY id ASC`,
  )
    .bind(letterId)
    .all<LetterRecipient>();

  // 只补发尚未成功的收件人（sent 的收件人不会重发）。
  const todo = recipients.results.filter((r) => r.status !== "sent");

  if (todo.length === 0) {
    // 没有需要发送的收件人（如全部已成功但 letters 仍停留在 sending）：收尾置 sent。
    await markLetterSent(env, letterId);
    return "delivered";
  }

  const failures: { email: string; error: string }[] = [];

  for (const recipient of todo) {
    const html = buildLetterHtml(letter);
    const result = await sendEmail(env, {
      to: recipient.email,
      subject: letter.title,
      html,
    });

    if (result.success) {
      await env.DB.prepare(
        `UPDATE letter_recipients SET status = 'sent', error = NULL, sent_at = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), recipient.id)
        .run();
    } else {
      const error = result.error ?? "SMTP error";
      failures.push({ email: recipient.email, error });
      await env.DB.prepare(
        `UPDATE letter_recipients SET status = 'failed', error = ?, sent_at = NULL WHERE id = ?`,
      )
        .bind(error, recipient.id)
        .run();
    }
  }

  if (failures.length === 0) {
    await markLetterSent(env, letterId);
    return "delivered";
  }

  const attempts = letter.attempts + 1;
  const lastError = failures
    .map((f) => `${f.email}: ${f.error}`)
    .join("; ");

  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE letters SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(attempts, lastError, new Date().toISOString(), letterId)
      .run();
    return "gaveUp";
  }

  // 部分失败：回到 scheduled，下个 cron 周期只补发失败收件人（sent 的不会重发）。
  await env.DB.prepare(
    `UPDATE letters SET status = 'scheduled', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(attempts, lastError, new Date().toISOString(), letterId)
    .run();
  return "partial";
}

async function markLetterSent(env: Env, letterId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE letters SET status = 'sent', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(now, now, letterId)
    .run();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 「写于 YYYY-MM-DD」——信件写作日期（created_at），按用户时区格式化。 */
function formatWrittenDate(createdAtIso: string, timezone: string): string {
  const date = new Date(createdAtIso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * 简洁信件模板：标题 + 消毒后的正文 + 落款「这封信写于 YYYY-MM-DD，由时光邮局送达」。
 * 标题单独 HTML 转义（不经过 body 白名单，避免标题里的标签注入）。
 */
export function buildLetterHtml(letter: Letter): string {
  const body = sanitizeBodyHtml(letter.body_html);
  const title = escapeHtml(letter.title);
  const writtenDate = formatWrittenDate(letter.created_at, letter.timezone);
  const signature = writtenDate
    ? `这封信写于 ${writtenDate}，由时光邮局送达`
    : "由时光邮局送达";

  return (
    `<div>` +
    `${title ? `<h2>${title}</h2>` : ""}` +
    `${body}` +
    `<p style="margin-top: 24px; color: #888;">${signature}</p>` +
    `</div>`
  );
}
