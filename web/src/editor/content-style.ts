// 信件正文渲染样式（SPEC §5）：编辑器与邮件预览共用同一套样式，
// 保证「编辑器里所见 ≈ 邮件里所得」，不做两套样式。
// 白名单消毒后的 body_html 在公开墙按此样式渲染，这里同样适用。
export const LETTER_CONTENT_CLASS = [
  "font-serif text-[15px] leading-relaxed text-ink-900",
  "[&_p]:mb-3 [&_p:last-child]:mb-0",
  "[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_strong]:font-semibold",
  "[&_em]:italic",
  "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-paper-300 [&_blockquote]:pl-4 [&_blockquote]:text-ink-600",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6",
  "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:my-1 [&_li]:pl-1",
  "[&_a]:text-seal-600 [&_a]:underline [&_a]:underline-offset-2",
  "[&_hr]:my-6 [&_hr]:border-paper-300",
].join(" ");
