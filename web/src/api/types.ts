// 冻结契约（ONE-170/173，与后端对齐，不得私下变更）
// GET /api/public/letters → PublicLettersResponse，未登录可读，仅 is_public=1
export interface PublicLetter {
  id: string;
  title: string;
  body_html: string; // 后端消毒后的 HTML，前端直接渲染，不再放开原始 HTML
  send_at: string | null; // 送达时间（UTC ISO）
  sent_at: string | null; // 实际寄出时间
  created_at: string;
  recipient_masked: string; // 形如 ***@gmail.com
  author_name: string; // 用户昵称；空串表示「一位朋友」
}

export interface PublicLettersResponse {
  total_sent: number;
  letters: PublicLetter[];
}
