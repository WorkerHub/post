import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, Send } from "lucide-react";
import type { JSONContent } from "@tiptap/react";

import { contactsApi, lettersApi } from "@/api/client";
import type { Contact } from "@/api/contacts";
import type { Letter, LetterPayload, LetterRecipient, LetterStatus } from "@/api/letters";
import { LetterPreview } from "@/components/letter-preview";
import { RecipientPicker } from "@/components/recipient-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RichTextEditor } from "@/editor/rich-text-editor";
import { getDefaultSendAt, getUserTimezone, isAfterNow, toLocalInputValue, toUtcIso } from "@/lib/datetime";

const STATUS_LABEL: Record<LetterStatus, string> = {
  draft: "草稿",
  scheduled: "待寄出",
  sending: "发送中",
  sent: "已寄出",
  failed: "失败",
  cancelled: "已取消",
};

/** body_json 字符串优先（TipTap 文档 JSON 保真），缺失时回退 body_html。 */
function parseInitialContent(bodyJson: string, bodyHtml: string): string | JSONContent {
  if (bodyJson) {
    try {
      return JSON.parse(bodyJson) as JSONContent;
    } catch {
      // 非法 JSON 时回退 HTML
    }
  }
  return bodyHtml;
}

export default function ComposePage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [letterId, setLetterId] = useState<string | null>(id ?? null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [bodyJson, setBodyJson] = useState("");
  const [initialContent, setInitialContent] = useState<string | JSONContent>("");
  const [recipients, setRecipients] = useState<LetterRecipient[]>([]);
  const [sendAtLocal, setSendAtLocal] = useState(getDefaultSendAt());
  const [timezone, setTimezone] = useState(getUserTimezone());
  const [isPublic, setIsPublic] = useState(false);
  const [status, setStatus] = useState<LetterStatus>("draft");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 联系人数据源（写信页只读，写操作在联系人页）
  useEffect(() => {
    let cancelled = false;
    contactsApi
      .list()
      .then((list) => {
        if (!cancelled) setContacts(list);
      })
      .catch(() => {
        // 联系人加载失败不阻断写信，选择器显示为空列表
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 编辑模式：按 id 拉取信件回填。刚创建后 navigate 回填的 id 已本地持有（loadedId 命中），
  // 跳过重复拉取，避免表单/编辑器被 loading 态卸载重挂。
  useEffect(() => {
    if (!id || id === loadedId) return;
    let cancelled = false;
    setLoading(true);
    lettersApi
      .get(id)
      .then((letter) => {
        if (cancelled) return;
        setLetterId(letter.id);
        setLoadedId(letter.id);
        setTitle(letter.title);
        setBodyHtml(letter.body_html);
        setBodyJson(letter.body_json);
        setInitialContent(parseInitialContent(letter.body_json, letter.body_html));
        setRecipients(letter.recipients);
        setSendAtLocal(letter.send_at ? toLocalInputValue(letter.send_at) : getDefaultSendAt());
        setTimezone(letter.timezone || getUserTimezone());
        setIsPublic(letter.is_public);
        setStatus(letter.status);
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
  }, [id, loadedId]);

  const handleEditorChange = useCallback((html: string, json: JSONContent) => {
    setBodyHtml(html);
    setBodyJson(JSON.stringify(json));
  }, []);

  const buildPayload = (): LetterPayload => ({
    title: title.trim(),
    body_html: bodyHtml,
    body_json: bodyJson,
    send_at: sendAtLocal ? toUtcIso(sendAtLocal) : null,
    timezone,
    is_public: isPublic,
    recipients,
  });

  const persist = useCallback(async (): Promise<Letter> => {
    const payload = buildPayload();
    if (letterId) {
      return lettersApi.update(letterId, payload);
    }
    const created = await lettersApi.create(payload);
    setLetterId(created.id);
    setLoadedId(created.id);
    navigate(`/compose/${created.id}`, { replace: true });
    return created;
  }, [letterId, title, bodyHtml, bodyJson, sendAtLocal, timezone, isPublic, recipients, navigate]);

  const saveDraft = async () => {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const saved = await persist();
      setStatus(saved.status);
      setNotice("草稿已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const schedule = async () => {
    setError(null);
    setNotice(null);
    if (recipients.length === 0) {
      setError("请至少添加一位收件人");
      return;
    }
    if (!sendAtLocal || !isAfterNow(sendAtLocal)) {
      setError("送达时间须晚于当前时间");
      return;
    }
    setSaving(true);
    try {
      const saved = await persist();
      const scheduled = await lettersApi.schedule(saved.id);
      setStatus(scheduled.status);
      setNotice("已定时，将在设定的时间寄出");
    } catch (err) {
      setError(err instanceof Error ? err.message : "定时失败");
    } finally {
      setSaving(false);
    }
  };

  const cancelScheduled = async () => {
    if (!letterId) return;
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const cancelled = await lettersApi.cancel(letterId);
      setStatus(cancelled.status);
      setNotice("已取消寄送");
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消失败");
    } finally {
      setSaving(false);
    }
  };

  const meta = useMemo(() => {
    const list: string[] = [];
    if (recipients.length > 0) list.push(`收件人 ${recipients.length} 位`);
    list.push(status ? STATUS_LABEL[status] : "");
    return list.filter(Boolean);
  }, [recipients.length, status]);

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-ink-500">正在加载信件…</div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/letters"
            className="flex size-8 items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-paper-200 hover:text-ink-900"
            aria-label="返回我的信件"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <h1 className="font-serif text-2xl font-semibold">{isEdit ? "编辑信件" : "写信"}</h1>
          {status !== "draft" && (
            <Badge
              className={
                status === "scheduled" ? "border-seal-500/30 bg-seal-500/10 text-seal-600" : undefined
              }
            >
              {STATUS_LABEL[status]}
            </Badge>
          )}
        </div>
        <div className="hidden text-sm text-ink-500 sm:block">{meta.join(" · ")}</div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="space-y-5">
          <div>
            <label htmlFor="letter-title" className="mb-1.5 block text-sm font-medium text-ink-700">
              标题（邮件主题）
            </label>
            <Input
              id="letter-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="给未来的自己写点什么"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-ink-700">正文</span>
              <span className="text-xs text-ink-500">仅支持加粗 / 斜体 / 标题 / 引用 / 列表 / 链接 / 分割线</span>
            </div>
            <RichTextEditor
              initialContent={initialContent}
              onChange={handleEditorChange}
              placeholder="信件正文"
            />
          </div>

          <div>
            <div className="mb-1.5 text-sm font-medium text-ink-700">收件人</div>
            <RecipientPicker recipients={recipients} contacts={contacts} onChange={setRecipients} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="send-at" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
                <CalendarClock className="size-4 text-ink-500" />
                送达时间
              </label>
              <Input
                id="send-at"
                type="datetime-local"
                value={sendAtLocal}
                onChange={(e) => setSendAtLocal(e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-500">默认次日 09:00（时区 {timezone}）</p>
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink-700">公开到信墙</div>
              <div className="flex items-center gap-2">
                <Switch
                  id="is-public"
                  checked={isPublic}
                  onCheckedChange={(v) => setIsPublic(v)}
                  aria-label="公开到信墙"
                />
                <label htmlFor="is-public" className="text-sm text-ink-700">
                  {isPublic ? "公开（信封会出现在公开信墙）" : "不公开（仅收件人可见）"}
                </label>
              </div>
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
              {notice}
            </p>
          )}
        </section>

        <LetterPreview
          title={title}
          bodyHtml={bodyHtml}
          recipients={recipients}
          sendAtLocal={sendAtLocal}
          isPublic={isPublic}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-paper-300 pt-5">
        <Button variant="outline" onClick={saveDraft} disabled={saving}>
          存草稿
        </Button>
        <Button onClick={schedule} disabled={saving}>
          <Send className="size-4" />
          寄往未来
        </Button>
        {status === "scheduled" && (
          <Button variant="ghost" onClick={cancelScheduled} disabled={saving}>
            取消寄送
          </Button>
        )}
        <span className="text-xs text-ink-500">
          寄出前可随时修改内容、收件人与时间；存草稿无需收件人与时间。
        </span>
      </div>
    </div>
  );
}
