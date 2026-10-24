import { Outlet, Link, useLocation } from "react-router-dom";
import { Mail, Feather, Settings, Users, FileText, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/auth";

const NAV_ITEMS = [
  { to: "/letters", label: "我的信件", icon: FileText },
  { to: "/compose", label: "写信", icon: Feather },
  { to: "/contacts", label: "联系人", icon: Users },
  { to: "/settings", label: "设置", icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const clear = useAuthStore((s) => s.clear);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-paper-300 bg-paper-50">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-2 text-ink-900">
            <Mail className="size-5 text-seal-500" />
            <span className="font-serif text-lg font-semibold">时光邮局</span>
          </Link>
          <nav className="flex flex-1 items-center gap-1">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  pathname.startsWith(to)
                    ? "bg-paper-200 font-medium text-ink-900"
                    : "text-ink-600 hover:bg-paper-200 hover:text-ink-900"
                }`}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clear()}
            aria-label="退出登录"
          >
            <LogOut className="size-4" />
            退出
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
