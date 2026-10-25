import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { KeyRound, Smartphone, Trash2 } from "lucide-react";

import { IS_MOCK, twoFaApi } from "@/api/client";
import type { MeProfile, TotpSetup } from "@/api/settings";
import { TotpQr } from "@/components/totp-qr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

function StatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Badge className="border-seal-500/30 bg-seal-500/10 text-seal-600">已开启</Badge>
  ) : (
    <Badge>未开启</Badge>
  );
}

/** 密码确认弹窗（关闭 2FA 前需重输密码，照 eNotify 口径）。 */
function PasswordDialog({
  open,
  onOpenChange,
  title,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await onSubmit(password);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>请先输入账户密码确认身份。</DialogDescription>
        </DialogHeader>
        <div className="mt-4">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="账户密码"
            aria-label="账户密码"
          />
          {error && (
            <p role="alert" className="mt-2 rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !password}>
            {busy ? "处理中…" : "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SecuritySection({
  user,
  onSaved,
}: {
  user: MeProfile;
  onSaved: () => void;
}) {
  const [totpDialogOpen, setTotpDialogOpen] = useState(false);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [disableTotpOpen, setDisableTotpOpen] = useState(false);
  const [disablePasskeyOpen, setDisablePasskeyOpen] = useState(false);

  useEffect(() => {
    if (totpDialogOpen) {
      setSetup(null);
      setCode("");
      setError(null);
      setNotice(null);
      setBusy(true);
      twoFaApi
        .totpSetup()
        .then(setSetup)
        .catch((err) =>
          setError(err instanceof Error ? err.message : "无法开始 TOTP 开通"),
        )
        .finally(() => setBusy(false));
    }
  }, [totpDialogOpen]);

  const enableTotp = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await twoFaApi.totpEnable(code);
      setNotice("TOTP 已开启");
      setSetup(null);
      await onSaved();
      setTimeout(() => setTotpDialogOpen(false), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "开通失败");
    } finally {
      setBusy(false);
    }
  };

  const disableTotp = async (password: string) => {
    await twoFaApi.totpDisable(password);
    await onSaved();
  };

  const disablePasskey = async (password: string) => {
    await twoFaApi.passkeyDisable(password);
    await onSaved();
  };

  const registerPasskey = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (IS_MOCK) {
        await twoFaApi.passkeyRegisterVerify({ mock: true });
      } else {
        const options = (await twoFaApi.passkeyRegisterOptions()) as PublicKeyCredentialCreationOptionsJSON;
        const registration = await startRegistration({ optionsJSON: options });
        await twoFaApi.passkeyRegisterVerify(registration);
      }
      setNotice("通行密钥已注册");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>安全</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
            {notice}
          </p>
        )}

        {/* TOTP */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Smartphone className="mt-0.5 size-5 text-seal-500" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">TOTP 验证码</span>
                <StatusBadge enabled={user.twofa.totp_enabled} />
              </div>
              <p className="mt-1 text-sm text-ink-600">
                使用 Google Authenticator 等应用生成六位验证码。
              </p>
            </div>
          </div>
          {user.twofa.totp_enabled ? (
            <Button variant="ghost" onClick={() => setDisableTotpOpen(true)}>
              <Trash2 className="size-4" />
              关闭
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setTotpDialogOpen(true)}>
              开启
            </Button>
          )}
        </div>

        {/* Passkey */}
        <div className="flex items-center justify-between gap-3 border-t border-paper-200 pt-5">
          <div className="flex items-start gap-2.5">
            <KeyRound className="mt-0.5 size-5 text-seal-500" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">通行密钥（Passkey）</span>
                <StatusBadge enabled={user.twofa.passkey_enabled} />
              </div>
              <p className="mt-1 text-sm text-ink-600">
                使用设备指纹 / Face ID / Windows Hello 免密登录。
              </p>
            </div>
          </div>
          {user.twofa.passkey_enabled ? (
            <Button variant="ghost" onClick={() => setDisablePasskeyOpen(true)}>
              <Trash2 className="size-4" />
              关闭
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void registerPasskey()} disabled={busy}>
              注册
            </Button>
          )}
        </div>
      </CardContent>

      {/* TOTP 开通对话框 */}
      <Dialog open={totpDialogOpen} onOpenChange={setTotpDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>开启 TOTP</DialogTitle>
            <DialogDescription>
              用验证器应用扫描二维码，或手动输入密钥，再填入应用生成的六位验证码。
            </DialogDescription>
          </DialogHeader>
          {busy && !setup ? (
            <div className="my-6 text-center text-sm text-ink-500">正在生成密钥…</div>
          ) : setup ? (
            <div className="mt-4 space-y-4">
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                <TotpQr uri={setup.uri} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-700">手动输入密钥</p>
                  <code className="mt-1 block break-all rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-700">
                    {setup.secret}
                  </code>
                </div>
              </div>
              <div>
                <label htmlFor="totp-code" className="mb-1.5 block text-sm font-medium text-ink-700">
                  六位验证码
                </label>
                <Input
                  id="totp-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  inputMode="numeric"
                  maxLength={6}
                />
              </div>
              {error && (
                <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
                  {error}
                </p>
              )}
              {notice && (
                <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
                  {notice}
                </p>
              )}
            </div>
          ) : (
            <p role="alert" className="mt-4 rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTotpDialogOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void enableTotp()} disabled={busy || !setup || code.length < 6}>
              验证并开启
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordDialog
        open={disableTotpOpen}
        onOpenChange={setDisableTotpOpen}
        title="关闭 TOTP"
        onSubmit={disableTotp}
      />
      <PasswordDialog
        open={disablePasskeyOpen}
        onOpenChange={setDisablePasskeyOpen}
        title="关闭通行密钥"
        onSubmit={disablePasskey}
      />
    </Card>
  );
}
