import { Navigate } from "react-router-dom";
import { FileText, Feather, Users, Settings } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useAuthStore } from "@/store/auth";

const WORKBENCH_CARDS = [
  { to: "/letters", label: "我的信件", icon: FileText, desc: "草稿 / 待寄出 / 已寄出 / 失败" },
  { to: "/compose", label: "写信", icon: Feather, desc: "写一封寄往未来的信" },
  { to: "/contacts", label: "联系人", icon: Users, desc: "收件人管理" },
  { to: "/settings", label: "设置", icon: Settings, desc: "昵称 / 时区 / 安全" },
];

export default function WorkbenchPage() {
  const displayName = useAuthStore((s) => s.displayName);
  if (!displayName) {
    // RequireAuth 已保证登录态；此处仅类型收窄
    return <Navigate to="/login" replace />;
  }
  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">
        你好，{displayName || "朋友"}
      </h1>
      <p className="mt-1 text-sm text-ink-600">今天想寄点什么给未来？</p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {WORKBENCH_CARDS.map(({ to, label, icon: Icon, desc }) => (
          <Card key={to} className="transition-shadow hover:shadow-md">
            <CardContent className="p-5">
              <Icon className="size-5 text-seal-500" />
              <p className="mt-3 font-medium">{label}</p>
              <p className="mt-1 text-sm text-ink-600">{desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-8 text-xs text-ink-500">
        工作台各视图的具体功能在后续任务中实现，当前为路由骨架占位。
      </p>
    </div>
  );
}
