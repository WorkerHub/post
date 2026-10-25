import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Feather,
  Inbox,
  Pencil,
  RotateCcw,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";

import { lettersApi } from "@/api/client";
import { LETTER_STATUS_LABEL, type Letter, type LetterStatus } from "@/api/letters";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";

type ViewKey = "draft" | "scheduled" | "sent" | "failed";

const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: "draft", label: "草稿" },
  { key: "scheduled", label: "待寄出" },
  { key: "sent", label: "已寄出" },
  { key: "failed", label: "失败" },
];

function viewMatches(key: ViewKey, status: LetterStatus): boolean {
  switch (key) {
    case "draft":
      // 已取消的信回到草稿视图（可重新编辑/删除），带「已取消」徽标
      return status === "draft" || status === "cancelled";
    case "scheduled":
      return status === "scheduled" || status === "sending";
    case "sent":
      return status === "sent";
    case "failed":
      return status === "failed";
  }
}

function statusBadgeClass(status: LetterStatus): string | undefined {
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

function LetterCard({
  letter,
  onResend,
  onCancel,
  onDelete,
  busy,
}: {
  letter: Letter;
  onResend: (letter: Letter) => void;
  onCancel: (letter: Letter) => void;
  onDelete: (letter: Letter) => void;
  busy: boolean;
}) {
  const meta: string[] = [];
  if (letter.status === "scheduled" || letter.status === "sending") {
    meta.push(`送达 ${formatDateTime(letter.send_at)}`);
  } else if (letter.status === "sent") {
    meta.push(`寄出于 ${formatDateTime(letter.sent_at)}`);
  } else {
    meta.push(`写于 ${formatDate(letter.created_at)}`);
  }
  if (letter.recipients.length > 0) {
    meta.push(`收件人 ${letter.recipients.length} 位`);
  }
  const editable = letter.status === "draft" || letter.status === "cancelled" || letter.status === "scheduled";

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {editable ? (
                <Link
                  to={`/compose/${letter.id}`}
                  className="font-serif text-base font-semibold text-ink-900 hover:text-seal-600 hover:underline"
                >
                  {letter.title || "（无标题）"}
                </Link>
              ) : (
                <span className="font-serif text-base font-semibold text-ink-900">
                  {letter.title || "（无标题）"}
                </span>
              )}
              <Badge className={statusBadgeClass(letter.status)}>
                {LETTER_STATUS_LABEL[letter.status]}
              </Badge>
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
              {meta.map((m) => (
                <span key={m}>{m}</span>
              ))}
              {letter.is_public && (
                <span className="inline-flex items-center gap-1 text-seal-600">
                  <Users className="size-3.5" />
                  公开到信墙
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {editable && (
              <Button asChild variant="ghost" size="sm" disabled={busy}>
                <Link to={`/compose/${letter.id}`}>
                  <Pencil className="size-3.5" />
                  编辑
                </Link>
              </Button>
            )}
            {letter.status === "scheduled" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onCancel(letter)}
              >
                <XCircle className="size-3.5" />
                取消
              </Button>
            )}
            {letter.status === "failed" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onResend(letter)}
              >
                <RotateCcw className="size-3.5" />
                重发
              </Button>
            )}
            {letter.status !== "sent" &&
              letter.status !== "scheduled" &&
              letter.status !== "sending" && (
              <Button
                variant="ghost"
                size="sm"
                className="text-ink-500 hover:text-[#9a2f22]"
                disabled={busy}
                onClick={() => onDelete(letter)}
              >
                <Trash2 className="size-3.5" />
                删除
              </Button>
            )}
          </div>
        </div>

        {letter.status === "failed" && letter.last_error && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-[#9a2f22]/20 bg-[#9a2f22]/5 px-3 py-2 text-xs text-[#9a2f22]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-all">
              失败原因：{letter.last_error}（已尝试 {letter.attempts} 次）
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function LettersPage() {
  const displayName = useAuthStore((s) => s.user?.display_name);
  const [letters, setLetters] = useState<Letter[]>([]);
  const [view, setView] = useState<ViewKey>("draft");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [resendTarget, setResendTarget] = useState<Letter | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Letter | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Letter | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLetters(await lettersApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<ViewKey, number> = { draft: 0, scheduled: 0, sent: 0, failed: 0 };
    for (const l of letters) {
      for (const { key } of VIEWS) {
        if (viewMatches(key, l.status)) c[key] += 1;
      }
    }
    return c;
  }, [letters]);

  const visible = useMemo(
    () => letters.filter((l) => viewMatches(view, l.status)),
    [letters, view],
  );

  const runAction = async (fn: () => Promise<unknown>, errPrefix: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(`${errPrefix}：${err instanceof Error ? err.message : "操作失败"}`);
    } finally {
      setBusy(false);
    }
  };

  const handleResend = () => {
    if (!resendTarget) return;
    const target = resendTarget;
    setResendTarget(null);
    void runAction(() => lettersApi.resend(target.id), "重发失败");
  };

  const handleCancel = () => {
    if (!cancelTarget) return;
    const target = cancelTarget;
    setCancelTarget(null);
    void runAction(() => lettersApi.cancel(target.id), "取消失败");
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    void runAction(() => lettersApi.remove(target.id), "删除失败");
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">
            你好，{displayName || "朋友"}
          </h1>
          <p className="mt-1 text-sm text-ink-600">我的信件</p>
        </div>
        <Button asChild>
          <Link to="/compose">
            <Feather className="size-4" />
            写信
          </Link>
        </Button>
      </div>

      <div className="mt-6 flex gap-1 border-b border-paper-300">
        {VIEWS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm transition-colors ${
              view === key
                ? "border-seal-500 font-medium text-ink-900"
                : "border-transparent text-ink-600 hover:text-ink-900"
            }`}
          >
            {label}
            <span className="rounded-full bg-paper-200 px-1.5 text-xs text-ink-600">
              {counts[key]}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
          {error}
        </p>
      )}

      <div className="mt-5 space-y-3">
        {loading ? (
          <p className="py-16 text-center text-sm text-ink-500">正在加载信件…</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-[6px] border border-dashed border-paper-300 py-16 text-center">
            <Inbox className="size-8 text-paper-300" />
            <p className="text-sm text-ink-500">
              {view === "draft" ? "还没有草稿" : view === "scheduled" ? "没有待寄出的信" : view === "sent" ? "还没有寄出的信" : "没有寄送失败的信"}
            </p>
            {view === "draft" && (
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link to="/compose">
                  <Feather className="size-3.5" />
                  写第一封信
                </Link>
              </Button>
            )}
          </div>
        ) : (
          visible.map((letter) => (
            <LetterCard
              key={letter.id}
              letter={letter}
              onResend={setResendTarget}
              onCancel={setCancelTarget}
              onDelete={setDeleteTarget}
              busy={busy}
            />
          ))
        )}
      </div>

      <ConfirmDialog
        open={resendTarget !== null}
        onOpenChange={(o) => !o && setResendTarget(null)}
        title="重新寄送这封信？"
        description="重发会将信放回待寄出队列，并重置重试次数为 0。"
        confirmLabel="确认重发"
        loading={busy}
        onConfirm={handleResend}
      />
      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(o) => !o && setCancelTarget(null)}
        title="取消寄送？"
        description="取消后信将不再寄出，可在草稿视图中重新编辑或删除。"
        confirmLabel="确认取消"
        danger
        loading={busy}
        onConfirm={handleCancel}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="删除这封信？"
        description="删除后不可恢复。"
        confirmLabel="确认删除"
        danger
        loading={busy}
        onConfirm={handleDelete}
      />
    </div>
  );
}
