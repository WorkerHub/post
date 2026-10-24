import type { PublicLettersResponse } from "@/api/types";

// 示例信：墙为空或不足时展示并标注「示例」，有真实公开信后自动让位。
// 仅包含冻结契约中的公开字段，不含任何私有信字段。
export const SAMPLE_LETTERS = [
  {
    id: "sample-1",
    title: "写给三年后的自己",
    body_html:
      "<p>三年后的你：</p><p>不知道现在的你有没有搬到想去的城市，有没有养成一直念叨的晨跑习惯。今天刚下过雨，窗外的桂花开了，突然很想跟未来的你说一句：<strong>别急，慢慢来，该来的都在路上。</strong></p>",
    send_at: "2029-10-24T01:00:00.000Z",
    sent_at: null,
    created_at: "2026-10-24T01:00:00.000Z",
    recipient_masked: "***@gmail.com",
    author_name: "",
  },
  {
    id: "sample-2",
    title: "给妈妈的一封信",
    body_html:
      "<p>妈：</p><p>这是我在时光邮局写给你的第一封信。等你收到的时候，我应该已经学会做你拿手的那道红烧鱼了。</p><ul><li>记得按时吃药</li><li>别总舍不得开空调</li></ul><p>女儿一切都好，勿念。</p>",
    send_at: "2027-01-01T01:00:00.000Z",
    sent_at: null,
    created_at: "2026-10-24T01:00:00.000Z",
    recipient_masked: "***@163.com",
    author_name: "小满",
  },
  {
    id: "sample-3",
    title: "寄往毕业那天",
    body_html:
      "<p>亲爱的自己：</p><blockquote>愿你走出半生，归来仍是少年。</blockquote><p>四年很长，长到足够成为想成为的人；四年也很短，短到来不及好好告别。所以提前把这句话寄给那一天的你。</p>",
    send_at: "2028-06-30T01:00:00.000Z",
    sent_at: null,
    created_at: "2026-10-24T01:00:00.000Z",
    recipient_masked: "***@qq.com",
    author_name: "阿澈",
  },
] as const;

export function buildMockResponse(): PublicLettersResponse {
  return {
    total_sent: 128,
    letters: SAMPLE_LETTERS.map((letter) => ({ ...letter })),
  };
}
