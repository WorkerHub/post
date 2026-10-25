import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowLeft, Mail } from "lucide-react";

import { authApi } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/store/auth";

export default function RegisterPage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // 已登录访问注册页 → 直接去工作台
  if (isAuthenticated) {
    return <Navigate to="/letters" replace />;
  }

  const submit = async () => {
    setError(null);
    if (!email.trim()) {
      setError("请填写邮箱");
      return;
    }
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      await authApi.register(email.trim(), password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-[6px] border border-paper-300 bg-paper-50 p-8 shadow-[0_1px_3px_rgba(58,53,42,0.08)]">
        <div className="flex items-center gap-2">
          <Mail className="size-5 text-seal-500" />
          <h1 className="font-serif text-xl font-semibold">注册时光邮局</h1>
        </div>

        {done ? (
          <div className="mt-6 space-y-4">
            <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
              注册成功！你的账号正在等待管理员批准，批准后即可登录使用。
            </p>
            <Button asChild className="w-full">
              <Link to="/login">去登录</Link>
            </Button>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div>
              <label htmlFor="reg-email" className="mb-1.5 block text-sm font-medium text-ink-700">
                邮箱
              </label>
              <Input
                id="reg-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="reg-password" className="mb-1.5 block text-sm font-medium text-ink-700">
                密码
              </label>
              <Input
                id="reg-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label htmlFor="reg-confirm" className="mb-1.5 block text-sm font-medium text-ink-700">
                确认密码
              </label>
              <Input
                id="reg-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再输入一次"
                autoComplete="new-password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
                {error}
              </p>
            )}
            <Button className="w-full" onClick={() => void submit()} disabled={busy}>
              {busy ? "注册中…" : "注册"}
            </Button>
            <p className="text-center text-sm text-ink-600">
              已有账号？{" "}
              <Link to="/login" className="text-seal-600 hover:underline">
                登录
              </Link>
            </p>
            <p className="text-center text-xs text-ink-500">
              注册后需管理员批准才能登录使用。
            </p>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-ink-500">
          <Link to="/" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="size-3.5" />
            返回公开信墙
          </Link>
        </p>
      </div>
    </div>
  );
}
