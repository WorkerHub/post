import { Link } from "react-router-dom";
import { Feather, FileText, Settings, Users } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useAuthStore } from "@/store/auth";

const WORKBENCH_CARDS = [
  {
    to: "/letters",
    label: "我的信件",
    icon: FileText,
    desc: "草稿 / 待寄出 / 已寄出 / 失败",
  },
  { to: "/compose", label: "写信", icon: Feather, desc: "写一封寄往未来的信" },
  { to: "/contacts", label: "联系人", icon: Users, desc: "收件人管理" },
  { to: "/settings", label: "设置", icon: Settings, desc: "昵称 / 时区 / 安全" },
];

// 登录后的「我的信件」工作台（SPEC §9）。
// 四个视图（草稿 / 待寄出 / 已寄出 / 失败）与各模块具体功能在后续单实现。
export default function LettersPage() {
  // 无昵称的合法登录用户用「朋友」兜底，不踢回登录页
  const displayName = useAuthStore((s) => s.displayName);

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">
        你好，{displayName || "朋友"}
      </h1>
      <p className="mt-1 text-sm text-ink-600">今天想寄点什么给未来？</p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {WORKBENCH_CARDS.map(({ to, label, icon: Icon, desc }) => (
          <Link key={to} to={to} className="group rounded-[6px] focus-visible:outline-none">
            <Card className="h-full transition-shadow group-hover:shadow-md">
              <CardContent className="p-5">
                <Icon className="size-5 text-seal-500" />
                <p className="mt-3 font-medium">{label}</p>
                <p className="mt-1 text-sm text-ink-600">{desc}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <p className="mt-8 text-xs text-ink-500">
        工作台各视图的具体功能在后续任务中实现，当前为路由骨架占位。
      </p>
    </div>
  );
}
