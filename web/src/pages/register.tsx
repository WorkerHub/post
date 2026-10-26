import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowLeft, Mail, ShieldCheck } from "lucide-react";

import { authApi } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/store/auth";
import { useRegistrationStore } from "@/store/registration";
import { useSetupStore } from "@/store/setup";

// 注册页（ONE-314）：setup 未初始化时注册必被后端 403，这里直接引导到 /setup；
// setup 关闭后首个注册账号是管理员，其余账号待管理员批准。
// ONE-336：管理员关闭注册后（GET /api/auth/registration-state 返回 enabled=false）
// 不渲染表单，只展示「注册已关闭」；状态未取得（null，如接口失败）时不关门——
// 后端 POST /api/auth/register 才是最终裁决，不因前端读不到状态把注册入口误关。
export default function RegisterPage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setupEnabled = useSetupStore((s) => s.enabled);
  const registrationEnabled = useRegistrationStore((s) => s.enabled);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** null = 未提交；"admin" = 首账号成为管理员；"pending" = 等管理员批准。 */
  const [done, setDone] = useState<null | "admin" | "pending">(null);

  // 已登录访问注册页 → 直接去工作台
  if (isAuthenticated) {
    return <Navigate to="/letters" replace />;
  }

  // 未初始化：注册入口一律让位给初始化页
  if (setupEnabled === true) {
    return <Navigate to="/setup" replace />;
  }

  // 注册开关关闭：不渲染表单，只留一句「已关闭」和回登录 / 公开墙的去处
  if (registrationEnabled === false) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm rounded-[6px] border border-paper-300 bg-paper-50 p-8 shadow-[0_1px_3px_rgba(58,53,42,0.08)]">
          <div className="flex items-center gap-2">
            <Mail className="size-5 text-seal-500" />
            <h1 className="font-serif text-xl font-semibold">注册时光邮局</h1>
          </div>

          <p className="mt-6 rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
            注册已关闭，暂不接受新用户注册
          </p>

          <Button asChild className="mt-6 w-full">
            <Link to="/login">返回登录</Link>
          </Button>

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
      const result = await authApi.register(email.trim(), password);
      setDone(result.admin ? "admin" : "pending");
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

        {done === "admin" && (
          <div className="mt-6 space-y-4">
            <p className="flex items-start gap-2 rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-ink-700">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-seal-500" />
              <span>
                注册成功！你已成为本站管理员。登录后可在设置页完成 SMTP
                配置并批准其他账号。
              </span>
            </p>
            <Button asChild className="w-full">
              <Link to="/login">去登录</Link>
            </Button>
          </div>
        )}

        {done === "pending" && (
          <div className="mt-6 space-y-4">
            <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
              注册成功！你的账号正在等待管理员批准，批准后即可登录使用。
            </p>
            <Button asChild className="w-full">
              <Link to="/login">去登录</Link>
            </Button>
          </div>
        )}

        {done === null && (
          // ONE-370：注册表单独立成 <form>（§5B 第一信号），邮箱 + 密码 + 确认密码同属这一个 form；
          // noValidate 保留页面自定义校验文案。
          <form
            name="register"
            className="mt-6 space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div>
              <label htmlFor="reg-email" className="mb-1.5 block text-sm font-medium text-ink-700">
                邮箱
              </label>
              <Input
                id="reg-email"
                name="email"
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
                name="password"
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
                name="confirm-password"
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
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "注册中…" : "注册"}
            </Button>
            <p className="text-center text-sm text-ink-600">
              已有账号？{" "}
              <Link to="/login" className="text-seal-600 hover:underline">
                登录
              </Link>
            </p>
            <p className="text-center text-xs text-ink-500">
              第一个注册的账号将成为管理员；之后的账号需管理员批准后才能登录。
            </p>
          </form>
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
