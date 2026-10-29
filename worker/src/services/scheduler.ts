import type { Env, Letter, LetterRecipient } from "../types";
import { getTablePrefix, tables } from "../types";
import { getSetting, setSetting } from "../db/queries/users";
import { sendEmail } from "./email";
import { sanitizeBodyHtml } from "./sanitize";
import {
  SEND_PAUSED_KEY,
  classifySendFailure,
  formatDeliveryError,
  readSendThrottleConfig,
  sendGapMs,
  sleepMs,
  throttleBackoffMs,
  type SendFailureClassification,
  type SendThrottleConfig,
} from "./send-throttle";

// cron 调度与逐收件人投递（SPEC §5 + 发信节流补遗 §3）。
// 防重复用 D1 状态抢占（不用 KV dedupe）：
//   UPDATE {prefix}letters SET status='sending' WHERE id=? AND status='scheduled'
// 影响行数为 1 才发送；同一封信被并发 cron 抢占时只有一方会拿到行数=1。
// 逐收件人单独发一封（独立 RCPT，收件人之间互不可见）；全部成功 → letters 置 sent；
// 部分失败 → 失败者记录 error，letters attempts+1 回到 scheduled，下个周期只补发失败收件人；
// attempts 达 3 次仍失败 → letters 置 failed、last_error 汇总。
//
// 节流补遗叠加的三件事（不影响上面的抢占与补发口径）：
// 1. 间隔 + 单轮收件人上限：本轮最多处理 max_recipients_per_run 个收件人，封与封之间
//    interval+jitter；额度用尽/接近平台回调超时就不再抢占，剩余信留 scheduled 下轮继续；
//    信只发了一部分时未发收件人保持 pending、信回 scheduled（绝不卡在 sending）。
// 2. 限流感知退避：421/450/451/452 或限流关键词 → attempts 不加、throttle_attempts+1、
//    next_attempt_at 按 15/30/60 分钟递增退避，并写 send_paused_until 熔断整轮。
// 3. 每收件人副本唯一 Message-ID（成功后落库 message_id），落款带信件编号。

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 50;
/** 没有回调上下文（如原生 cron 入口）时的单轮预算：waker 任务的默认超时。 */
const DEFAULT_RUN_TIMEOUT_SECONDS = 30;
/** 运行预算里给收尾（DB 写入、SDK 返回）留的余量。 */
const RUN_DEADLINE_RESERVE_MS = 10_000;
/** 单封 SMTP 事务本身的余量：剩余时间不够发下一封就顺延，不硬塞。 */
const ONE_MESSAGE_RESERVE_MS = 10_000;
/** 限流退避窗口：退避时刻超过 send_at + 24 小时即置 failed。 */
const THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DeliveryStats {
  /** 本轮扫到的到期信数（受 BATCH_SIZE 限制） */
  scanned: number;
  /** 本轮抢占成功的信数 */
  claimed: number;
  /** 本轮全部收件人发送成功的信数 */
  delivered: number;
  /** 本轮部分收件人失败、信回到 scheduled 的次数 */
  partialFailed: number;
  /** 本轮被置 failed 的信数（attempts 达 3 次，或限流退避超过 24 小时） */
  failed: number;
  /** 本轮命中限流类的收件人数 */
  throttled: number;
  /** 因单轮上限/运行预算顺延到下一轮的收件人数 */
  deferred_by_cap: number;
  /** 熔断截止时刻（UTC ISO）：本轮处于熔断中（入口即熔断或本轮触发）时有值 */
  paused_until: string | null;
}

export interface DeliveryRunOptions {
  /** 平台回调带来的单次执行超时（秒）；缺省按 waker 默认 30 秒。 */
  timeoutSeconds?: number;
}

/** 单轮运行的共享状态：配置、时间预算、收件人额度、统计。 */
interface RunState {
  config: SendThrottleConfig;
  /** 不再开始新投递的时刻（epoch ms） */
  deadline: number;
  /** 剩余可投递的收件人数 */
  budget: number;
  /** 本轮已完成的 SMTP 投递事务数（首封不等待，其后每封前等待间隔） */
  sentInRun: number;
  /** 本轮触发了熔断（限流类）：立即停止剩余发送 */
  paused: boolean;
  pauseUntil: string | null;
  stats: DeliveryStats;
}

function emptyStats(): DeliveryStats {
  return {
    scanned: 0,
    claimed: 0,
    delivered: 0,
    partialFailed: 0,
    failed: 0,
    throttled: 0,
    deferred_by_cap: 0,
    paused_until: null,
  };
}

function createRunState(
  config: SendThrottleConfig,
  timeoutSeconds: number,
  stats: DeliveryStats = emptyStats(),
): RunState {
  const seconds =
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds
      : DEFAULT_RUN_TIMEOUT_SECONDS;
  return {
    config,
    deadline: Date.now() + seconds * 1000 - RUN_DEADLINE_RESERVE_MS,
    budget: config.max_recipients_per_run,
    sentInRun: 0,
    paused: false,
    pauseUntil: null,
    stats,
  };
}

/** 本轮是否还该开始一次新的投递（首封必发，保证每轮都有进展）。 */
function canStartAnotherSend(run: RunState, gapMs: number): boolean {
  if (run.sentInRun === 0) return true;
  return Date.now() + gapMs + ONE_MESSAGE_RESERVE_MS <= run.deadline;
}

export async function processDueLetters(
  env: Env,
  options: DeliveryRunOptions = {},
): Promise<DeliveryStats> {
  const T = tables(env);
  const prefix = getTablePrefix(env);
  const now = new Date().toISOString();
  const stats = emptyStats();

  // 熔断期内触发的扫描：直接跳过发送，不抢占任何信（补遗 §3.2.4）。
  // 值被写坏（不可解析的时刻）时按「未熔断」处理：宁可发信，也不永久卡死投递。
  const pausedUntil = await getSetting(env.DB, prefix, SEND_PAUSED_KEY);
  if (pausedUntil !== null) {
    const pausedUntilMs = Date.parse(pausedUntil);
    if (Number.isFinite(pausedUntilMs) && pausedUntilMs > Date.now()) {
      stats.paused_until = pausedUntil;
      return stats;
    }
  }

  const config = await readSendThrottleConfig(env.DB, prefix);
  const run = createRunState(config, options.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS, stats);

  const due = await env.DB.prepare(
    `SELECT l.id AS id,
            (SELECT COUNT(*) FROM ${T.letter_recipients} r
              WHERE r.letter_id = l.id AND r.status <> 'sent') AS pending
       FROM ${T.letters} l
      WHERE l.status = 'scheduled' AND l.send_at IS NOT NULL AND l.send_at <= ?
        AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= ?)
      ORDER BY l.send_at ASC, l.id ASC
      LIMIT ?`,
  )
    .bind(now, now, BATCH_SIZE)
    .all<{ id: string; pending: number }>();

  stats.scanned = due.results.length;

  for (const row of due.results) {
    if (run.paused) break; // 熔断：本轮剩余发送立即停止
    const pending = Number(row.pending ?? 0);

    // 计数在抢占之前生效：额度/时间用尽则不改状态，自然顺延到下一轮。
    if (
      run.budget <= 0 ||
      (run.sentInRun > 0 && Date.now() >= run.deadline)
    ) {
      stats.deferred_by_cap += pending;
      continue;
    }

    try {
      await deliverLetterWithRun(env, row.id, run);
    } catch (err) {
      console.error(`Delivery error for letter ${row.id}:`, err);
    }
  }

  if (run.pauseUntil !== null) stats.paused_until = run.pauseUntil;

  return stats;
}

type DeliverOutcome =
  | "delivered"
  | "partial"
  | "failed"
  | "throttled"
  | "deferred"
  | "skipped"
  | "error";

/**
 * 单封信投递（保留原签名）：用默认配置与预算构造一次独立运行。
 * 批量路径（processDueLetters）复用同一实现，只是共享 run 的额度与预算。
 */
export async function deliverLetter(
  env: Env,
  letterId: string,
): Promise<DeliverOutcome> {
  const config = await readSendThrottleConfig(env.DB, getTablePrefix(env));
  const run = createRunState(config, DEFAULT_RUN_TIMEOUT_SECONDS);
  return deliverLetterWithRun(env, letterId, run);
}

async function deliverLetterWithRun(
  env: Env,
  letterId: string,
  run: RunState,
): Promise<DeliverOutcome> {
  const T = tables(env);
  const now = new Date().toISOString();

  // 状态抢占：只有把 scheduled → sending 的这一次更新生效（changes=1）才继续发送。
  const claim = await env.DB.prepare(
    `UPDATE ${T.letters} SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'scheduled'`,
  )
    .bind(now, letterId)
    .run();

  if (!claim.meta?.changes || claim.meta.changes !== 1) {
    return "skipped";
  }
  run.stats.claimed++;

  try {
    return await deliverClaimedLetter(env, letterId, run);
  } catch (err) {
    // 意外异常：把信退回 scheduled，避免永久卡在 sending（attempts 不变，下个周期重试）。
    console.error(`Delivery error for letter ${letterId}:`, err);
    try {
      await env.DB.prepare(
        `UPDATE ${T.letters} SET status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'sending'`,
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
  run: RunState,
): Promise<DeliverOutcome> {
  const T = tables(env);
  const letter = await env.DB.prepare(`SELECT * FROM ${T.letters} WHERE id = ?`)
    .bind(letterId)
    .first<Letter>();
  if (!letter) return "error";

  const recipients = await env.DB.prepare(
    `SELECT * FROM ${T.letter_recipients} WHERE letter_id = ? ORDER BY id ASC`,
  )
    .bind(letterId)
    .all<LetterRecipient>();

  // 只补发尚未成功的收件人（sent 的收件人不会重发）。
  const todo = recipients.results.filter((r) => r.status !== "sent");

  if (todo.length === 0) {
    // 没有需要发送的收件人（如全部已成功但 letters 仍停留在 sending）：收尾置 sent。
    await markLetterSent(env, letterId);
    run.stats.delivered++;
    return "delivered";
  }

  const failures: { email: string; error: string }[] = [];
  const html = buildLetterHtml(letter);
  let deferred = 0;

  for (let i = 0; i < todo.length; i++) {
    const recipient = todo[i]!;

    // 额度用尽 / 剩余时间不够下一封 → 未发收件人保持 pending，信按「半发」回 scheduled。
    const gapMs = sendGapMs(run.config);
    if (run.budget <= 0 || !canStartAnotherSend(run, gapMs)) {
      deferred = todo.length - i;
      break;
    }

    if (run.sentInRun > 0) {
      await sleepMs(gapMs);
    }

    const sentAt = new Date().toISOString();
    const result = await sendEmail(env, {
      to: recipient.email,
      subject: letter.title,
      html,
      letterId: letter.id,
      recipientId: recipient.id,
    });
    run.sentInRun++;
    run.budget--;

    console.info("delivery send:", {
      letter: letter.id,
      recipient: recipient.id,
      at: sentAt,
      waitMs: run.sentInRun > 1 ? gapMs : 0,
      ok: result.success,
    });

    if (result.success) {
      await env.DB.prepare(
        `UPDATE ${T.letter_recipients} SET status = 'sent', error = NULL, sent_at = ?, message_id = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), result.messageId ?? null, recipient.id)
        .run();
      continue;
    }

    const classification = classifySendFailure({
      code: result.code ?? null,
      text: result.error ?? "SMTP error",
    });

    await env.DB.prepare(
      `UPDATE ${T.letter_recipients} SET status = 'failed', error = ?, sent_at = NULL WHERE id = ?`,
    )
      .bind(formatDeliveryError(classification), recipient.id)
      .run();

    if (classification.kind === "throttle") {
      run.stats.throttled++;
      await handleThrottledLetter(env, letter, recipient, classification, run);
      return "throttled";
    }

    failures.push({
      email: recipient.email,
      error: formatDeliveryError(classification),
    });
  }

  if (failures.length === 0 && deferred === 0) {
    await markLetterSent(env, letterId);
    run.stats.delivered++;
    return "delivered";
  }

  if (failures.length === 0) {
    // 只发了其中一部分（单轮上限/运行预算）：不算失败，attempts 与 last_error 不动。
    run.stats.deferred_by_cap += deferred;
    await env.DB.prepare(
      `UPDATE ${T.letters} SET status = 'scheduled', updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), letterId)
      .run();
    return "deferred";
  }

  if (deferred > 0) run.stats.deferred_by_cap += deferred;

  const attempts = letter.attempts + 1;
  const lastError = failures.map((f) => `${f.email}: ${f.error}`).join("; ");

  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE ${T.letters} SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(attempts, lastError, new Date().toISOString(), letterId)
      .run();
    run.stats.failed++;
    return "failed";
  }

  // 部分失败：回到 scheduled，下个 cron 周期只补发失败收件人（sent 的不会重发）。
  await env.DB.prepare(
    `UPDATE ${T.letters} SET status = 'scheduled', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(attempts, lastError, new Date().toISOString(), letterId)
    .run();
  run.stats.partialFailed++;
  return "partial";
}

/**
 * 限流类错误：不动 attempts，按 throttle_attempts 递增退避，并熔断整轮（补遗 §3.2）。
 * 退避时刻超过 `send_at + 24h` 则直接置 failed（用户可手动重发，重发会清空节流字段）。
 */
async function handleThrottledLetter(
  env: Env,
  letter: Letter,
  recipient: LetterRecipient,
  classification: SendFailureClassification,
  run: RunState,
): Promise<void> {
  const T = tables(env);
  const nowMs = Date.now();
  const throttleAttempts = (letter.throttle_attempts ?? 0) + 1;
  const backoffMs = throttleBackoffMs(throttleAttempts);
  const nextAttemptAt = new Date(nowMs + backoffMs).toISOString();
  const pausedUntil = new Date(nowMs + backoffMs).toISOString();
  const detail = formatDeliveryError(classification);

  // 熔断：本轮剩余发送立即停止（不再逐封硬撞）。
  await setSetting(env.DB, getTablePrefix(env), SEND_PAUSED_KEY, pausedUntil);
  run.paused = true;
  run.pauseUntil = pausedUntil;

  const windowEnd = letterWindowEnd(letter);
  const overWindow = windowEnd !== null && Date.parse(nextAttemptAt) > windowEnd;
  const lastError = overWindow
    ? `${recipient.email}: ${detail}（限流退避至 ${nextAttemptAt}，已超过 send_at + 24 小时，置失败）`
    : `${recipient.email}: ${detail}（限流退避至 ${nextAttemptAt}，第 ${throttleAttempts} 次）`;

  await env.DB.prepare(
    `UPDATE ${T.letters}
        SET status = ?, throttle_attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      overWindow ? "failed" : "scheduled",
      throttleAttempts,
      nextAttemptAt,
      lastError,
      new Date().toISOString(),
      letter.id,
    )
    .run();

  if (overWindow) run.stats.failed++;
}

/** `send_at + 24h` 的 epoch ms；send_at 缺失/不可解析时 null（不套用窗口）。 */
function letterWindowEnd(letter: Letter): number | null {
  if (!letter.send_at) return null;
  const sendAt = Date.parse(letter.send_at);
  if (Number.isNaN(sendAt)) return null;
  return sendAt + THROTTLE_WINDOW_MS;
}

async function markLetterSent(env: Env, letterId: string): Promise<void> {
  const T = tables(env);
  const now = new Date().toISOString();
  // 成功即清零（补遗 §3.2.5）：退避状态随成功一并清掉。
  await env.DB.prepare(
    `UPDATE ${T.letters}
        SET status = 'sent', sent_at = ?, last_error = NULL, next_attempt_at = NULL,
            throttle_attempts = 0, updated_at = ?
      WHERE id = ?`,
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
 * 简洁信件模板：标题 + 消毒后的正文 + 落款「这封信写于 YYYY-MM-DD，由时光邮局送达」+「信件编号：{id}」。
 * 标题单独 HTML 转义（不经过 body 白名单，避免标题里的标签注入）。
 * 信件编号只进落款，绝不改用户的正文/标题（补遗 §3.3.3）。
 */
export function buildLetterHtml(letter: Letter): string {
  const body = sanitizeBodyHtml(letter.body_html);
  const title = escapeHtml(letter.title);
  const writtenDate = formatWrittenDate(letter.created_at, letter.timezone);
  const signature = writtenDate
    ? `这封信写于 ${writtenDate}，由时光邮局送达`
    : "由时光邮局送达";
  const letterNo = `<p style="margin-top: 4px; color: #aaa; font-size: 12px;">信件编号：${escapeHtml(letter.id)}</p>`;

  return (
    `<div>` +
    `${title ? `<h2>${title}</h2>` : ""}` +
    `${body}` +
    `<p style="margin-top: 24px; color: #888;">${signature}</p>` +
    letterNo +
    `</div>`
  );
}
