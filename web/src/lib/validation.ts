/** 邮箱格式校验（前端落快照前的手填邮箱校验；权威校验在后端）。 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}
