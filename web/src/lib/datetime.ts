/** 送达时间相关工具（SPEC §5）：默认次日 09:00，用户本地时区（默认 Asia/Shanghai），须晚于当前时间。 */

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 用户浏览器本地 IANA 时区；解析失败兜底 Asia/Shanghai。 */
export function getUserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** 本地时间 → `YYYY-MM-DDTHH:mm`（datetime-local 输入框所需格式）。 */
function formatLocalInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

/** 默认送达时间：次日 09:00（浏览器本地时区）。 */
export function getDefaultSendAt(now: Date = new Date()): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
  return formatLocalInputValue(next);
}

/** 本地 datetime-local 值 → UTC ISO 字符串（`YYYY-MM-DDTHH:mm` 无 Z 后缀时按本地时区解析）。 */
export function toUtcIso(localInputValue: string): string {
  return new Date(localInputValue).toISOString();
}

/** UTC ISO → 本地 datetime-local 值（编辑时回填）。 */
export function toLocalInputValue(utcIso: string): string {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";
  return formatLocalInputValue(d);
}

/** 送达时间是否晚于当前时间（datetime-local 值为本地时区）。 */
export function isAfterNow(localInputValue: string, now: Date = new Date()): boolean {
  const t = new Date(localInputValue).getTime();
  if (Number.isNaN(t)) return false;
  return t > now.getTime();
}

/** 常用 IANA 时区固定列表（供设置页下拉选择，顺序即显示顺序）。 */
const TIMEZONES: readonly string[] = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Bangkok",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** IANA 时区列表（供设置页下拉选择）：固定常用列表，保证顺序与结果稳定。 */
export function getTimezones(): string[] {
  return [...TIMEZONES];
}
