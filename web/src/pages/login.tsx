import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ArrowLeft, KeyRound, Mail, ShieldCheck } from "lucide-react";

import { authApi, IS_MOCK } from "@/api/client";
import type { MeProfile } from "@/api/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/store/auth";

type Step = "credentials" | "twofa";

export default function LoginPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tempToken, setTempToken] = useState("");
  const [methods, setMethods] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已登录访问登录页 → 直接去工作台（避免卡死在 /login）
  if (isAuthenticated) {
    return <Navigate to="/letters" replace />;
  }


  const finish = (user: MeProfile) => {
    setUser(user);
    navigate("/letters", { replace: true });
  };

  const submitCredentials = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError("请填写邮箱和密码");
      return;
    }
    setBusy(true);
    try {
      const result = await authApi.login(email.trim(), password);
      if (result.requires2fa) {
        setTempToken(result.tempToken);
        setMethods(result.availableMethods);
        setStep("twofa");
      } else {
        finish(result.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async () => {
    setError(null);
    if (code.length < 6) {
      setError("请输入六位验证码");
      return;
    }
    setBusy(true);
    try {
      const user = await authApi.verify2fa(tempToken, "totp", code);
      finish(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证失败");
    } finally {
      setBusy(false);
    }
  };

  const submitPasskey = async () => {
    setError(null);
    setBusy(true);
    try {
      if (IS_MOCK) {
        const user = await authApi.passkeyAuthenticateVerify(tempToken, { mock: true });
        finish(user);
      } else {
        const options = (await authApi.passkeyAuthenticateOptions(
          tempToken,
        )) as PublicKeyCredentialRequestOptionsJSON;
        const assertion = await startAuthentication({ optionsJSON: options });
        const user = await authApi.passkeyAuthenticateVerify(tempToken, assertion);
        finish(user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "通行密钥验证失败");
    } finally {
      setBusy(false);
    }
  };

  const backToCredentials = () => {
    setStep("credentials");
    setCode("");
    setError(null);
    setTempToken("");
    setMethods([]);
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-[6px] border border-paper-300 bg-paper-50 p-8 shadow-[0_1px_3px_rgba(58,53,42,0.08)]">
        <div className="flex items-center gap-2">
          <Mail className="size-5 text-seal-500" />
          <h1 className="font-serif text-xl font-semibold">登录时光邮局</h1>
        </div>

        {step === "credentials" ? (
          <div className="mt-6 space-y-4">
            <div>
              <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium text-ink-700">
                邮箱
              </label>
              <Input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium text-ink-700">
                密码
              </label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitCredentials();
                  }
                }}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
                {error}
              </p>
            )}
            <Button className="w-full" onClick={() => void submitCredentials()} disabled={busy}>
              {busy ? "登录中…" : "登录"}
            </Button>
            <p className="text-center text-sm text-ink-600">
              还没有账号？{" "}
              <Link to="/register" className="text-seal-600 hover:underline">
                注册
              </Link>
            </p>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <p className="text-sm text-ink-600">
              该账号开启了双重验证，请完成以下验证。
            </p>
            {methods.includes("totp") && (
              <div>
                <label htmlFor="login-code" className="mb-1.5 block text-sm font-medium text-ink-700">
                  六位验证码
                </label>
                <Input
                  id="login-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  inputMode="numeric"
                  maxLength={6}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitTotp();
                    }
                  }}
                />
                <Button
                  className="mt-3 w-full"
                  onClick={() => void submitTotp()}
                  disabled={busy}
                >
                  <ShieldCheck className="size-4" />
                  {busy ? "验证中…" : "验证"}
                </Button>
              </div>
            )}
            {methods.includes("passkey") && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => void submitPasskey()}
                disabled={busy}
              >
                <KeyRound className="size-4" />
                使用通行密钥验证
              </Button>
            )}
            {error && (
              <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={backToCredentials}
              className="flex items-center gap-1 text-sm text-ink-600 hover:text-ink-900"
            >
              <ArrowLeft className="size-3.5" />
              返回账号密码登录
            </button>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-ink-500">
          <Link to="/" className="hover:underline">
            ← 返回公开信墙
          </Link>
        </p>
      </div>
    </div>
  );
}
