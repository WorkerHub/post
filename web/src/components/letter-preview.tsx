import { Clock, Globe, Users } from "lucide-react";

import type { LetterRecipient } from "@/api/letters";
import { LETTER_CONTENT_CLASS } from "@/editor/content-style";
import { formatDate } from "@/lib/utils";

export interface LetterPreviewProps {
  title: string;
  bodyHtml: string;
  recipients: LetterRecipient[];
  /** 已格式化的送达时间（YYYY-MM-DD HH:mm）；空串表示未设定。 */
  sendAtLocal: string;
  isPublic: boolean;
  /** 写信日期（ISO）；缺省为当前时间（写信页预览用「今天」）。 */
  writtenAt?: string;
}

/**
 * 信件预览：写信页与详情页共用同一份「按邮件实际渲染效果」，
 * 不做第二套正文渲染（SPEC §5 + fleet-discipline §3）。
 */
export function LetterPreview({
  title,
  bodyHtml,
  recipients,
  sendAtLocal,
  isPublic,
  writtenAt,
}: LetterPreviewProps) {
  return (
    <aside className="rounded-[6px] border border-paper-300 bg-paper-50 shadow-[0_1px_3px_rgba(58,53,42,0.08)]">
      <div className="border-b border-paper-300 px-5 py-3">
        <p className="text-xs text-ink-500">预览 · 按邮件实际渲染效果</p>
      </div>
      <div className="space-y-4 p-5">
        <div>
          <p className="text-xs text-ink-500">主题</p>
          <p className="mt-1 font-serif text-lg font-semibold text-ink-900">
            {title || "（无标题）"}
          </p>
        </div>
        <div className="border-t border-paper-200 pt-4">
          {/* 正文为编辑器生成的受限集 HTML，与邮件正文同一套样式渲染 */}
          <div
            className={LETTER_CONTENT_CLASS}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
          <p className="mt-6 border-t border-paper-200 pt-3 text-sm text-ink-500">
            这封信写于 {formatDate(writtenAt ?? new Date().toISOString())}，由时光邮局送达
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-paper-200 pt-3 text-xs text-ink-600">
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5" />
            {recipients.length > 0 ? `收件人 ${recipients.length} 位` : "未添加收件人"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" />
            {sendAtLocal ? `送达 ${sendAtLocal.replace("T", " ")}` : "未设定送达时间"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Globe className="size-3.5" />
            {isPublic ? "公开到信墙" : "仅收件人可见"}
          </span>
        </div>
      </div>
    </aside>
  );
}
