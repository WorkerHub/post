import { useState } from "react";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import {
  Bold,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LETTER_CONTENT_CLASS } from "@/editor/content-style";
import { composeExtensions } from "@/editor/extensions";

export interface RichTextEditorProps {
  /** 初始内容：HTML 字符串或 TipTap JSONContent（编辑时回填）。 */
  initialContent: string | JSONContent;
  onChange: (html: string, json: JSONContent) => void;
  placeholder?: string;
}

function ToolbarButton({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-paper-200 text-seal-600"
          : "text-ink-600 hover:bg-paper-200 hover:text-ink-900",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {children}
    </button>
  );
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function RichTextEditor({
  initialContent,
  onChange,
  placeholder,
}: RichTextEditorProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const editor = useEditor({
    extensions: composeExtensions,
    content: initialContent,
    shouldRerenderOnTransaction: true,
    onCreate: ({ editor }) => onChange(editor.getHTML(), editor.getJSON()),
    onUpdate: ({ editor }) => onChange(editor.getHTML(), editor.getJSON()),
  });

  if (!editor) return null;

  const openLinkPanel = () => {
    const href = editor.isActive("link")
      ? (editor.getAttributes("link").href as string | undefined) ?? ""
      : "";
    setLinkUrl(href);
    setLinkOpen(true);
  };

  const applyLink = () => {
    const href = normalizeUrl(linkUrl);
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkOpen(false);
  };

  return (
    <div className="rounded-[6px] border border-paper-300 bg-paper-50">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-paper-300 px-2 py-1">
        <ToolbarButton
          label="加粗"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="斜体"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="二级标题"
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="三级标题"
          active={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="引用"
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="无序列表"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="有序列表"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="链接"
          active={editor.isActive("link")}
          onClick={openLinkPanel}
        >
          <Link2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="分割线"
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          <Minus className="size-4" />
        </ToolbarButton>
      </div>

      {linkOpen && (
        <div className="flex items-center gap-2 border-b border-paper-300 bg-paper-100 px-3 py-2">
          <Input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
            }}
            placeholder="https://example.com"
            aria-label="链接地址"
            className="h-8 flex-1"
          />
          <Button type="button" size="sm" onClick={applyLink}>
            确定
          </Button>
          {editor.isActive("link") && (
            <Button type="button" size="sm" variant="ghost" onClick={removeLink}>
              <X className="size-4" />
              移除
            </Button>
          )}
        </div>
      )}

      <EditorContent
        editor={editor}
        className={cn(
          LETTER_CONTENT_CLASS,
          "min-h-64 px-4 py-3 focus:outline-none",
        )}
        aria-label={placeholder ?? "信件正文"}
      />
    </div>
  );
}
