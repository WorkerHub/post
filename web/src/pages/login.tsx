import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ArrowLeft, KeyRound, Mail, ShieldCheck } from "lucide-react";

import { authApi, IS_MOCK, settingsApi } from "@/api/client";
import type { MeProfile } from "@/api/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/store/auth";
import { useRegistrationStore } from "@/store/registration";
import { useSetupStore } from "@/store/setup";

type Step = "credentials" | "twofa";

export default function LoginPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setupEnabled = useSetupStore((s) => s.enabled);
  // 注册开关（ONE-336）：关闭时隐藏「注册」入口；状态未取得（null）不误隐藏。
  const registrationEnabled = useRegistrationStore((s) => s.enabled);

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

  // 初始化未完成时还没有任何账号，登录无意义 → 引导到初始化页
  if (setupEnabled === true) {
    return <Navigate to="/setup" replace />;
  }


  // 登录/2FA 接口只回公开档案（后端 publicUser 不含 twofa），而设置页「安全」区块要读
  // user.twofa——直接拿登录响应的 user 落 store，登录后首次进设置页会抛错空白，刷新才恢复
  // （ONE-332）。会话 Cookie 建立后、写入 store 前补一次 GET /api/settings/me，用完整档案落 store。
  const finish = async () => {
    let profile: MeProfile;
    try {
      profile = await settingsApi.getSettings();
    } catch {
      // 会话已建立但档案读取失败：不把缺 twofa 的半残档案写进 store（那样设置页照样空白），
      // 留在登录页提示重试；重试或刷新都会重新走完整档案路径。
      throw new Error("登录成功，但读取账户信息失败，请重试");
    }
    setUser(profile);
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
        await finish();
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
      await authApi.verify2fa(tempToken, "totp", code);
      await finish();
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
        await authApi.passkeyAuthenticateVerify(tempToken, { mock: true });
        await finish();
      } else {
        const options = (await authApi.passkeyAuthenticateOptions(
          tempToken,
        )) as PublicKeyCredentialRequestOptionsJSON;
        const assertion = await startAuthentication({ optionsJSON: options });
        await authApi.passkeyAuthenticateVerify(tempToken, assertion);
        await finish();
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
          // ONE-370：凭据步骤独立成 <form>，给密码管理器一个明确的表单边界（§5B 第一信号）。
          // noValidate：保留页面自定义校验与错误提示，不让浏览器原生校验气泡拦下提交。
          // ONE-390 方案 A：两步 form 用不同 key ⇒ 切换时 React 卸载/重挂载整棵子树。
          // 否则两个 <form> 在同一位置同类型，React 会复用节点并原地把 type=password 的
          // input 改写成 type=text，密码管理器对已缓存元素不重读属性，验证码框就被当成
          // 密码框误填账户密码（§4b 红线）。零视觉变更，无新依赖。
          <form
            key="login-credentials"
            name="login-credentials"
            className="mt-6 space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submitCredentials();
            }}
          >
            <div>
              <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium text-ink-700">
                邮箱
              </label>
              <Input
                id="login-email"
                name="email"
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
                name="password"
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
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "登录中…" : "登录"}
            </Button>
            {registrationEnabled !== false && (
              <p className="text-center text-sm text-ink-600">
                还没有账号？{" "}
                <Link to="/register" className="text-seal-600 hover:underline">
                  注册
                </Link>
              </p>
            )}
          </form>
        ) : (
          // ONE-370：二次验证独立成 form，密码框在另一步骤的另一 form 内——验证码框与密码框
          // 永不共享表单边界（§5B「密码与 TOTP 分步呈现」在结构层落地）。
          <form
            key="login-twofa"
            name="login-twofa"
            className="mt-6 space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submitTotp();
            }}
          >
            <p className="text-sm text-ink-600">
              该账号开启了双重验证，请完成以下验证。
            </p>
            {methods.includes("totp") && (
              <div>
                <label htmlFor="otp-code" className="mb-1.5 block text-sm font-medium text-ink-700">
                  六位验证码
                </label>
                {/* 属性集保持 ONE-335 后的合规态（text / one-time-code / numeric / 单框 / maxLength=6）；
                    本次只改 id 与 name：去掉 id 里的 `login` 词根，消除 Bitwarden
                    AmbiguousUsernameFieldNames 的弱 username 歧义（ONE-368 §5 第 5 条 + 评审 nit 2）。 */}
                <Input
                  id="otp-code"
                  name="otp-code"
                  type="text"
                  autoComplete="one-time-code"
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
                <Button type="submit" className="mt-3 w-full" disabled={busy}>
                  <ShieldCheck className="size-4" />
                  {busy ? "验证中…" : "验证"}
                </Button>
              </div>
            )}
            {methods.includes("passkey") && (
              <Button
                type="button"
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
          </form>
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
