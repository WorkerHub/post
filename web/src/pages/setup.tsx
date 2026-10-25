import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, KeyRound, Mail, ShieldCheck } from "lucide-react";

import { setupApi } from "@/api/client";
import { SetupError } from "@/api/setup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetupStore } from "@/store/setup";

// 可视化初始化页（ONE-314，契约见 ONE-313）：
// 只填一个 SETUP_SECRET 完成初始化，不创建任何账号——初始化之后第一个通过注册页
// 注册的用户才是管理员。密钥只进组件状态与 POST body：不写 store/localStorage、
// 不进 URL、不回显，成功后立即清空。
type Phase = "loading" | "form" | "closed" | "done" | "unreachable";

/** 把接口错误翻成人话：403 密钥错/已完成，500 服务端未配置密钥，其余兜底。 */
export function describeSetupError(err: unknown): string {
  if (err instanceof SetupError) {
    if (err.status === 403) {
      return /closed/i.test(err.message)
        ? "本站已完成初始化，无需再次初始化。"
        : "初始化密钥不正确，请检查后重试。";
    }
    if (err.status === 500) {
      return "服务端没有配置有效的初始化密钥（SETUP_SECRET），初始化暂时不可用，请联系部署者。";
    }
    if (err.status === 400) {
      return "提交内容无效，请刷新页面后重试。";
    }
    return `初始化失败（${err.message}），请稍后再试。`;
  }
  return "网络异常，初始化失败，请稍后再试。";
}

export default function SetupPage() {
  const setSetupEnabled = useSetupStore((s) => s.setEnabled);

  const [phase, setPhase] = useState<Phase>("loading");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const { enabled } = await setupApi.fetchState();
      setSetupEnabled(enabled);
      setPhase(enabled ? "form" : "closed");
    } catch {
      setPhase("unreachable");
    }
  }, [setSetupEnabled]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const submit = async () => {
    setError(null);
    if (!secret.trim()) {
      setError("请填写初始化密钥（SETUP_SECRET）。");
      return;
    }
    setBusy(true);
    try {
      await setupApi.submit(secret.trim());
      setSecret("");
      setSetupEnabled(false);
      setPhase("done");
    } catch (err) {
      setError(describeSetupError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-[6px] border border-paper-300 bg-paper-50 p-8 shadow-[0_1px_3px_rgba(58,53,42,0.08)]">
        <div className="flex items-center gap-2">
          <Mail className="size-5 text-seal-500" />
          <h1 className="font-serif text-xl font-semibold">初始化时光邮局</h1>
        </div>

        {phase === "loading" && (
          <p className="mt-6 text-sm text-ink-600">正在读取初始化状态…</p>
        )}

        {phase === "unreachable" && (
          <div className="mt-6 space-y-4">
            <p className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
              无法读取初始化状态，请检查网络后重试。
            </p>
            <Button className="w-full" onClick={() => void loadState()}>
              重试
            </Button>
          </div>
        )}

        {phase === "form" && (
          <div className="mt-6 space-y-4">
            <p className="text-sm leading-relaxed text-ink-600">
              填入部署时配置的初始化密钥（SETUP_SECRET），完成本站初始化。
              初始化不会创建账号——完成后请前往注册，第一个注册的账号将成为管理员。
            </p>
            <div>
              <label
                htmlFor="setup-secret"
                className="mb-1.5 block text-sm font-medium text-ink-700"
              >
                初始化密钥
              </label>
              <Input
                id="setup-secret"
                type="password"
                name="setup_secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="部署时配置的 SETUP_SECRET"
                autoComplete="off"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
            {error && (
              <p
                role="alert"
                className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600"
              >
                {error}
              </p>
            )}
            <Button className="w-full" onClick={() => void submit()} disabled={busy}>
              <KeyRound className="size-4" />
              {busy ? "初始化中…" : "完成初始化"}
            </Button>
            <p className="text-center text-xs text-ink-500">
              密钥仅用于本次初始化，不会被保存或显示。
            </p>
          </div>
        )}

        {phase === "done" && (
          <div className="mt-6 space-y-4">
            <p className="flex items-start gap-2 rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-seal-500" />
              <span>
                初始化已完成。现在去注册第一个账号吧——它将成为本站管理员，此后注册的账号需要管理员批准。
              </span>
            </p>
            <Button asChild className="w-full">
              <Link to="/register">去注册（第一个账号即管理员）</Link>
            </Button>
            <p className="text-center text-sm text-ink-600">
              已有账号？{" "}
              <Link to="/login" className="text-seal-600 hover:underline">
                登录
              </Link>
            </p>
          </div>
        )}

        {phase === "closed" && (
          <div className="mt-6 space-y-4">
            <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
              本站已完成初始化，无需再次初始化。
            </p>
            <Button asChild className="w-full">
              <Link to="/login">去登录</Link>
            </Button>
            <p className="text-center text-sm text-ink-600">
              还没有账号？{" "}
              <Link to="/register" className="text-seal-600 hover:underline">
                注册
              </Link>
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
