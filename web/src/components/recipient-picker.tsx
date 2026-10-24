import { useMemo, useState } from "react";
import { Search, UserPlus, X } from "lucide-react";

import type { Contact } from "@/api/contacts";
import type { LetterRecipient } from "@/api/letters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isValidEmail } from "@/lib/validation";

export interface RecipientPickerProps {
  recipients: LetterRecipient[];
  contacts: Contact[];
  onChange: (recipients: LetterRecipient[]) => void;
}

function RecipientChip({
  recipient,
  onRemove,
}: {
  recipient: LetterRecipient;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-paper-300 bg-paper-100 py-1 pr-1 pl-3 text-sm text-ink-700">
      <span>
        {recipient.name ? `${recipient.name} ` : ""}
        <span className="text-ink-500">&lt;{recipient.email}&gt;</span>
      </span>
      <button
        type="button"
        aria-label={`移除 ${recipient.email}`}
        onClick={onRemove}
        className="flex size-5 items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-paper-300 hover:text-ink-900"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/** 收件人选择器（SPEC §5/§7）：联系人多选 + 手填任意邮箱（落快照，name 可空）。 */
export function RecipientPicker({
  recipients,
  contacts,
  onChange,
}: RecipientPickerProps) {
  const [query, setQuery] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const selectedEmails = useMemo(
    () => new Set(recipients.map((r) => r.email.toLowerCase())),
    [recipients],
  );

  const filteredContacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q),
    );
  }, [contacts, query]);

  const addRecipient = (recipient: LetterRecipient) => {
    if (selectedEmails.has(recipient.email.toLowerCase())) return;
    onChange([...recipients, recipient]);
  };

  const removeRecipient = (email: string) => {
    onChange(recipients.filter((r) => r.email !== email));
  };

  const addManual = () => {
    const email = manualEmail.trim();
    if (!email) return;
    if (!isValidEmail(email)) {
      setManualError("邮箱格式不正确");
      return;
    }
    setManualError(null);
    addRecipient({ contact_id: null, name: manualName.trim(), email });
    setManualName("");
    setManualEmail("");
  };

  return (
    <div className="space-y-4">
      {recipients.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {recipients.map((r) => (
            <RecipientChip
              key={r.email}
              recipient={r}
              onRemove={() => removeRecipient(r.email)}
            />
          ))}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
          <Search className="size-4 text-ink-500" />
          从联系人添加
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按姓名或邮箱搜索联系人"
          aria-label="搜索联系人"
        />
        {query.trim() !== "" && (
          <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-paper-300 bg-paper-50">
            {filteredContacts.length === 0 ? (
              <li className="px-3 py-2 text-sm text-ink-500">没有匹配的联系人</li>
            ) : (
              filteredContacts.map((c) => {
                const added = selectedEmails.has(c.email.toLowerCase());
                return (
                  <li key={c.id} className="border-b border-paper-100 last:border-0">
                    <button
                      type="button"
                      disabled={added}
                      onClick={() =>
                        addRecipient({
                          contact_id: c.id,
                          name: c.name,
                          email: c.email,
                        })
                      }
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-paper-100 disabled:opacity-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-ink-900">
                          {c.name || "（未命名）"}
                        </span>
                        <span className="block truncate text-xs text-ink-500">
                          {c.email}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-ink-500">
                        {added ? "已添加" : "添加"}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
          <UserPlus className="size-4 text-ink-500" />
          手填邮箱
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            placeholder="姓名（可选）"
            aria-label="收件人姓名（可选）"
            className="sm:w-40"
          />
          <Input
            type="email"
            value={manualEmail}
            onChange={(e) => {
              setManualEmail(e.target.value);
              if (manualError) setManualError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addManual();
              }
            }}
            placeholder="name@example.com"
            aria-label="收件人邮箱"
            className="flex-1"
          />
          <Button type="button" variant="outline" onClick={addManual}>
            添加
          </Button>
        </div>
        {manualError && <p className="mt-1 text-xs text-seal-600">{manualError}</p>}
      </div>
    </div>
  );
}
