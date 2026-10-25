// TipTap 受限扩展集（SPEC §2/§5，ONE-175 定稿）：只开信件排版够用的一组，
// 段落、二/三级标题、加粗、斜体、引用、有序/无序列表、链接、分割线。
// 不做图片上传、表格、代码块、文字颜色/高亮、附件。
import Blockquote from "@tiptap/extension-blockquote";
import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import Document from "@tiptap/extension-document";
import Heading from "@tiptap/extension-heading";
import History from "@tiptap/extension-history";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import ListItem from "@tiptap/extension-list-item";
import OrderedList from "@tiptap/extension-ordered-list";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";

export const composeExtensions = [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: [2, 3] }),
  Bold,
  Italic,
  Blockquote,
  BulletList,
  OrderedList,
  ListItem,
  Link.configure({
    openOnClick: false,
    autolink: false,
    linkOnPaste: false,
    defaultProtocol: "https",
    HTMLAttributes: {
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    },
  }),
  HorizontalRule,
  History,
];
