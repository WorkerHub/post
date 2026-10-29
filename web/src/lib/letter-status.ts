// 信件状态的前端判定与样式：工作台卡片（链接目标）与详情页（编辑入口）共用同一份，
// 避免两处各写一遍导致漂移。
import type { LetterStatus } from "@/api/letters";

/**
 * 是否允许编辑内容/收件人。与后端 `worker/src/routes/letters.ts` 的 `isEditableStatus` 同义：
 * 不可编辑状态（sent / failed / sending）只能只读查看，入口是详情页而非编辑器。
 */
export function isEditableStatus(status: LetterStatus): boolean {
  return status === "draft" || status === "scheduled" || status === "cancelled";
}

/** 状态徽标配色（默认 Badge 样式之外的状态覆盖）。 */
export function statusBadgeClass(status: LetterStatus): string | undefined {
  switch (status) {
    case "scheduled":
    case "sending":
      return "border-seal-500/30 bg-seal-500/10 text-seal-600";
    case "failed":
      return "border-[#9a2f22]/30 bg-[#9a2f22]/10 text-[#9a2f22]";
    case "sent":
      return "border-paper-300 bg-paper-100 text-ink-600";
    default:
      return undefined;
  }
}
