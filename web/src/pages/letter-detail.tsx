import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Pencil } from "lucide-react";

import { lettersApi } from "@/api/client";
import { LETTER_STATUS_LABEL, type Letter } from "@/api/letters";
import { LetterPreview } from "@/components/letter-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isEditableStatus, statusBadgeClass } from "@/lib/letter-status";
import { formatDate, formatDateTime } from "@/lib/utils";

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      <dt className="w-16 shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-ink-900">{children}</dd>
    </div>
  );
}

/**
 * 信件只读详情页（`/letters/:id`）：
 * 不可编辑状态（已寄出 / 失败 / 发送中）的信只能看不能改，入口从工作台卡片标题进来。
 * 正文与写信页共用 `LetterPreview`，不另做一套渲染（SPEC §5 + fleet-discipline §3）。
 */
export default function LetterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [letter, setLetter] = useState<Letter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setError("缺少信件 ID");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    lettersApi
      .get(id)
      .then((loaded) => {
        if (!cancelled) setLetter(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return <div className="py-16 text-center text-sm text-ink-500">正在加载信件…</div>;
  }

  if (error || !letter) {
    // 后端对不存在/非本人信件一律 404 且 body 为 "Not found"（fetchOwnedLetter），
    // 这里换成用户可读的文案，其余错误原样透出以便定位。
    const message = error === "Not found" ? "信件不存在或无权查看" : (error ?? "加载失败");
    return (
      <div className="py-16 text-center">
        <p
          role="alert"
          className="inline-block rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600"
        >
          无法打开这封信：{message}
        </p>
        <div className="mt-6">
          <Button asChild variant="outline" size="sm">
            <Link to="/letters">
              <ArrowLeft className="size-3.5" />
              返回我的信件
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const editable = isEditableStatus(letter.status);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/letters"
            aria-label="返回我的信件"
            className="flex size-8 items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-paper-200 hover:text-ink-900"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <h1 className="font-serif text-2xl font-semibold">信件详情</h1>
          <Badge className={statusBadgeClass(letter.status)}>
            {LETTER_STATUS_LABEL[letter.status]}
          </Badge>
        </div>
        {editable && (
          <Button asChild variant="outline" size="sm">
            <Link to={`/compose/${letter.id}`}>
              <Pencil className="size-3.5" />
              编辑
            </Link>
          </Button>
        )}
      </div>

      {letter.status === "failed" && letter.last_error && (
        <div className="mt-5 flex items-start gap-2 rounded-md border border-[#9a2f22]/20 bg-[#9a2f22]/5 px-3 py-2 text-xs text-[#9a2f22]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-all">
            失败原因：{letter.last_error}（已尝试 {letter.attempts} 次）
          </span>
        </div>
      )}

      <div className="mt-6">
        <LetterPreview
          title={letter.title}
          bodyHtml={letter.body_html}
          recipients={letter.recipients}
          sendAtLocal={formatDateTime(letter.send_at)}
          isPublic={letter.is_public}
          writtenAt={letter.created_at}
        />
      </div>

      <Card className="mt-6">
        <CardContent className="p-5">
          <h2 className="font-serif text-lg font-semibold text-ink-900">寄送信息</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <InfoRow label="收件人">
              {letter.recipients.length === 0 ? (
                <span className="text-ink-500">未添加收件人</span>
              ) : (
                <ul className="space-y-1">
                  {letter.recipients.map((r) => (
                    <li key={r.email}>
                      {r.name ? `${r.name} ` : ""}
                      <span className="text-ink-500">&lt;{r.email}&gt;</span>
                    </li>
                  ))}
                </ul>
              )}
            </InfoRow>
            {letter.sent_at && (
              <InfoRow label="寄出于">{formatDateTime(letter.sent_at)}</InfoRow>
            )}
            {letter.send_at && (
              <InfoRow label="送达时间">{formatDateTime(letter.send_at)}</InfoRow>
            )}
            <InfoRow label="写于">{formatDate(letter.created_at)}</InfoRow>
            <InfoRow label="可见范围">
              {letter.is_public ? "公开到信墙" : "仅收件人可见"}
            </InfoRow>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
