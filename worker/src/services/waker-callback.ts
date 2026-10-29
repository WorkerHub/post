// waker 回调入口的业务侧（ONE-566）：平台回调 → `processDueLetters(env)` → 返回本次统计。
//
// 冻结契约（父单 ONE-564 / 本单）：
//   - **同步语义**：handler await 到 processDueLetters 跑完才返回，SDK 才回 2xx；
//     抛错 → SDK 回 5xx 并释放幂等占位，平台按策略重试。绝不 `waitUntil + 立即 OK`。
//   - **验签**：HMAC-SHA256 覆盖 `timestamp + executionId + jobId + rawBody`，300s 时间窗；
//     全部由 SDK（`../waker`，waker v2.0.0 源码拷贝）完成，本文件不碰签名、不自建协议。
//   - **幂等**：executionId 由 SDK 的 D1 账本去重，落 someday 自己的 D1（`{prefix}waker_executions`，
//     见 db/migrations.ts 的 schema_v2）；业务层的 letterId 层状态抢占保持原样，仍是防重最终防线。
//
// 投递语义（节流补遗 §3）：单轮收件人上限 + 封间隔、限流退避与全局熔断、每收件人唯一
// Message-ID，均在 scheduler.ts；本文件只负责把平台回调的超时预算传下去。

import { getTablePrefix, tbl, type Env } from "../types";
import {
  createD1ExecutionLedger,
  createWakerReceiver,
  type WakerJobOutcome,
} from "../waker";
import { processDueLetters, type DeliveryStats } from "./scheduler";

/**
 * waker 平台侧注册的任务名——必须与平台里建的 job 名**逐字一致**（receiver 按名字分发，
 * 不一致会回 404 `unknown_job`）。注册由用户在 waker 管理面做，someday 不代填。
 */
export const DUE_LETTERS_JOB = "deliver-due-letters";

/** executionId 幂等账本表的后缀；完整表名一律经 tbl(prefix, ...) 加前缀，无第二份真源。 */
export const WAKER_EXECUTIONS_TABLE = "waker_executions";

/** `{prefix}waker_executions`：SDK 的 D1 幂等账本表（schema_v2 建）。 */
export function wakerExecutionsTable(env: Pick<Env, "TABLE_PREFIX">): string {
  return tbl(getTablePrefix(env), WAKER_EXECUTIONS_TABLE);
}

/** 回调 2xx 响应体里的业务字段：本次执行统计（口径 = `processDueLetters` 的返回值）。 */
export type DueLettersJobOutcome = WakerJobOutcome & { stats: DeliveryStats };

/**
 * 建一个绑定了本请求 env 的 receiver 子应用。
 *
 * receiver 的 signing key 由 SDK 从 `env.WAKER_SIGNING_KEY` 读（只来自 secrets，见 deploy workflow）；
 * 缺 key 时 SDK fail closed（回 500 `signing_key_missing`），不会「看起来正常地」放行。
 */
export function createWakerCallbackReceiver(env: Env) {
  return createWakerReceiver({
    jobs: {
      [DUE_LETTERS_JOB]: async (context): Promise<DueLettersJobOutcome> => {
        // 同步跑完再返回：SDK 只在这之后回 2xx，平台据此判定本次执行成功。
        // timeoutSeconds 来自平台任务策略（回调体自带），用来算本轮的时间预算：
        // 不在被平台判定超时前一刻还在发信（节流补遗 §3.1.3）。
        const stats = await processDueLetters(env, {
          timeoutSeconds: context.timeoutSeconds,
        });
        console.info("waker callback delivery run:", stats);
        return { stats };
      },
    },
    ledger: createD1ExecutionLedger(env.DB, {
      table: wakerExecutionsTable(env),
    }),
    onJobError: (error, context) => {
      console.error(
        `waker job ${context.jobName} (execution ${context.executionId}, attempt ${context.attempt}) failed:`,
        error,
      );
    },
  });
}
