import { useCallback, useEffect, useMemo, useState } from "react";
import { Mail, Pencil, Plus, Search, Trash2, UserRound } from "lucide-react";

import { contactsApi } from "@/api/client";
import type { Contact, ContactPayload } from "@/api/contacts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TagInput } from "@/components/tag-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isValidEmail } from "@/lib/validation";

function ContactFormDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact | null;
  onSaved: () => void;
}) {
  const isEdit = contact !== null;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时回填（新建清空，编辑回填）
  useEffect(() => {
    if (open) {
      setName(contact?.name ?? "");
      setEmail(contact?.email ?? "");
      setNotes(contact?.notes ?? "");
      setTags(contact?.tags ?? []);
      setError(null);
    }
  }, [open, contact]);

  const submit = async () => {
    setError(null);
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError("请填写邮箱");
      return;
    }
    if (!isValidEmail(normalizedEmail)) {
      setError("邮箱格式不正确");
      return;
    }
    const payload: ContactPayload = {
      name: name.trim(),
      email: normalizedEmail,
      notes: notes.trim(),
      tags,
    };
    setSaving(true);
    try {
      if (isEdit && contact) {
        await contactsApi.update(contact.id, payload);
      } else {
        await contactsApi.create(payload);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑联系人" : "新建联系人"}</DialogTitle>
          <DialogDescription>
            保存后可在写信页的收件人选择器中直接选用。
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="contact-name" className="mb-1.5 block text-sm font-medium text-ink-700">
              姓名
            </label>
            <Input
              id="contact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：妈妈"
            />
          </div>
          <div>
            <label htmlFor="contact-email" className="mb-1.5 block text-sm font-medium text-ink-700">
              邮箱
            </label>
            <Input
              id="contact-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </div>
          <div>
            <label htmlFor="contact-notes" className="mb-1.5 block text-sm font-medium text-ink-700">
              备注
            </label>
            <Textarea
              id="contact-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="可选"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-700">标签</label>
            <TagInput tags={tags} onChange={setTags} placeholder="输入标签后回车" />
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState<Contact | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContacts(await contactsApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [contacts, query]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (contact: Contact) => {
    setEditing(contact);
    setFormOpen(true);
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await contactsApi.remove(target.id);
      await load();
    } catch (err) {
      setError(`删除失败：${err instanceof Error ? err.message : "操作失败"}`);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">联系人</h1>
          <p className="mt-1 text-sm text-ink-600">
            管理收件人，写信页可直接选用。
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          新建联系人
        </Button>
      </div>

      <div className="mt-6 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按姓名、邮箱或标签搜索"
            aria-label="搜索联系人"
            className="pl-9"
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
          {error}
        </p>
      )}

      <div className="mt-5 space-y-3">
        {loading ? (
          <p className="py-16 text-center text-sm text-ink-500">正在加载联系人…</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-[6px] border border-dashed border-paper-300 py-16 text-center">
            <UserRound className="size-8 text-paper-300" />
            <p className="text-sm text-ink-500">
              {query ? "没有匹配的联系人" : "还没有联系人"}
            </p>
            {!query && (
              <Button variant="outline" size="sm" className="mt-2" onClick={openCreate}>
                <Plus className="size-3.5" />
                添加第一个联系人
              </Button>
            )}
          </div>
        ) : (
          filtered.map((contact) => (
            <Card key={contact.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-900">
                        {contact.name || "（未命名）"}
                      </span>
                      {contact.tags.map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-600">
                      <Mail className="size-3.5 text-ink-500" />
                      {contact.email}
                    </p>
                    {contact.notes && (
                      <p className="mt-1.5 text-sm text-ink-500">{contact.notes}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(contact)}>
                      <Pencil className="size-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-ink-500 hover:text-[#9a2f22]"
                      onClick={() => setDeleting(contact)}
                    >
                      <Trash2 className="size-3.5" />
                      删除
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <ContactFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editing}
        onSaved={() => void load()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="删除这个联系人？"
        description={deleting ? `${deleting.email} 将从联系人中移除，已存信件中的收件人快照不受影响。` : undefined}
        confirmLabel="确认删除"
        danger
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
