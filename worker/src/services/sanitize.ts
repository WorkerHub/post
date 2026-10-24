import sanitizeHtml from "sanitize-html";

// body_html 白名单消毒（SPEC §2/§5/§6，硬性安全要求）。
// 白名单只放行 TipTap 受限集对应的标签与属性：
//   段落 p、二/三级标题 h2/h3、加粗 strong/b、斜体 em/i、引用 blockquote、
//   有序/无序列表 ol/ul/li、链接 a、分割线 hr、换行 br。
// 剥除 script、style 等标签（含其内容）、事件属性（on*）、javascript:/data: 链接。
// 保存时与公开墙展示时共用同一套消毒（后端④公开墙 API 与本单发送路径共用）。

const ALLOWED_TAGS = [
  "p",
  "h2",
  "h3",
  "strong",
  "b",
  "em",
  "i",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "hr",
  "br",
];

const ALLOWED_SCHEMES = ["http", "https", "mailto"];

export function sanitizeBodyHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    // 只放行链接的 href；其余属性（含 on* 事件属性、style）一律剥除。
    allowedAttributes: {
      a: ["href"],
    },
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesByTag: {
      a: ALLOWED_SCHEMES,
    },
    // 协议相对地址（//host）不常见于信件正文且可被滥用，关闭。
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
  });
}
