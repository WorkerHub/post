import { useState } from "react";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";

export interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  inputId?: string;
}

/** 多标签输入：回车新建标签，点击 × 移除（SPEC §7「tags 多标签可输入新建」）。 */
export function TagInput({ tags, onChange, placeholder, inputId }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!tags.includes(value)) onChange([...tags, value]);
    setDraft("");
  };

  const remove = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-paper-300 bg-paper-100 py-0.5 pr-1 pl-2.5 text-xs text-ink-700"
            >
              {tag}
              <button
                type="button"
                aria-label={`移除标签 ${tag}`}
                onClick={() => remove(tag)}
                className="flex size-4 items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-paper-300 hover:text-ink-900"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        id={inputId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={placeholder ?? "输入标签后回车"}
      />
    </div>
  );
}
