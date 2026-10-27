import { useCallback, useEffect, useState } from "react";
import { Save, Send } from "lucide-react";

import { adminApi } from "@/api/client";
import type { SmtpConfig } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { isValidEmail } from "@/lib/validation";

export function SmtpSection() {
  const [config, setConfig] = useState<SmtpConfig | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("465");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [fromName, setFromName] = useState("");
  const [testTo, setTestTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await adminApi.getSmtp();
      setConfig(cfg);
      setHost(cfg.host);
      setPort(String(cfg.port));
      setUsername(cfg.username);
      setPassword("");
      setFrom(cfg.from);
      setFromName(cfg.from_name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setError(null);
    setNotice(null);
    const portNum = Number(port);
    if (!host.trim()) {
      setError("请填写 SMTP 服务器地址");
      return;
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError("端口须为 1–65535 的整数");
      return;
    }
    setSaving(true);
    try {
      await adminApi.updateSmtp({
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        // password 留空表示不改（后端脱敏，不回显明文）
        password,
        from: from.trim(),
        from_name: fromName.trim(),
      });
      setNotice("SMTP 配置已保存");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setError(null);
    setTestResult(null);
    if (!isValidEmail(testTo)) {
      setError("请填写有效的测试收件邮箱");
      return;
    }
    setTesting(true);
    try {
      setTestResult(await adminApi.testSmtp(testTo));
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : "发送失败" });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-ink-500">正在加载 SMTP 配置…</CardContent>
      </Card>
    );
  }

  const passwordConfigured = Boolean(config?.password_set);

  return (
    <Card>
      <CardHeader>
        <CardTitle>SMTP 配置</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ONE-370：SMTP 配置独立成一个专属 <form>（§5B 第一信号）。
            它不与登录 / 注册 / 验证码 / PasswordDialog 任何 form 共享边界；
            密码框定死 autoComplete="off" + name="smtp_password"，不会被当成站内登录凭据。 */}
        <form
          name="smtp-config"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="smtp-host" className="mb-1.5 block text-sm font-medium text-ink-700">
                服务器地址
              </label>
              <Input
                id="smtp-host"
                name="smtp_host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="smtp.example.com"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="smtp-port" className="mb-1.5 block text-sm font-medium text-ink-700">
                端口
              </label>
              <Input
                id="smtp-port"
                name="smtp_port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="465"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="smtp-username" className="mb-1.5 block text-sm font-medium text-ink-700">
                用户名
              </label>
              {/* nit 1：用户名也标 off，避免激进的管理器按「用户名 + 邻近密码框」撮合凭据对。 */}
              <Input
                id="smtp-username"
                name="smtp_username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="someday@example.com"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="smtp-password" className="mb-1.5 block text-sm font-medium text-ink-700">
                密码
              </label>
              {/* 评审定死（ONE-369）：SMTP 密码是第三方邮件服务配置凭证，不是本站账户密码 →
                  autoComplete 定死为 off（不得用 current-password / new-password）。
                  该密码框只属于本节这个 SMTP 专属 form，不与登录 / 注册 / 验证码 / PasswordDialog
                  任何 form 共享（§5 第 6 条）。这里没有再做一层独立 form：HTML 不允许 form 嵌套，
                  且嵌套后密码框在 DOM 里仍属于外层 form，隔离等于没做。 */}
              <Input
                id="smtp-password"
                name="smtp_password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={passwordConfigured ? "已配置，留空表示不改" : "SMTP 密码"}
                autoComplete="off"
              />
              {passwordConfigured && (
                <p className="mt-1 text-xs text-ink-500">密码已配置（脱敏，不回显明文）；留空保存表示不修改。</p>
              )}
            </div>
            <div>
              <label htmlFor="smtp-from" className="mb-1.5 block text-sm font-medium text-ink-700">
                发件邮箱
              </label>
              <Input
                id="smtp-from"
                name="smtp_from"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="someday@example.com"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="smtp-from-name" className="mb-1.5 block text-sm font-medium text-ink-700">
                发件人名称
              </label>
              <Input
                id="smtp-from-name"
                name="smtp_from_name"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="时光邮局"
                autoComplete="off"
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="mt-4 rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
              {error}
            </p>
          )}
          {notice && (
            <p className="mt-4 rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
              {notice}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={saving}>
              <Save className="size-4" />
              {saving ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </form>

        {/* ONE-370：测试邮件是独立 <form>（不与 SMTP 密码框同 form）。 */}
        <form
          name="smtp-test"
          className="border-t border-paper-200 pt-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void test();
          }}
        >
          <p className="mb-2 text-sm font-medium text-ink-700">发送测试邮件</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="smtp-test-to"
              name="smtp_test_recipient"
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="测试收件邮箱"
              aria-label="测试收件邮箱"
              autoComplete="off"
              className="flex-1"
            />
            <Button type="submit" variant="outline" disabled={testing}>
              <Send className="size-4" />
              {testing ? "发送中…" : "发送测试邮件"}
            </Button>
          </div>
          {testResult && (
            <div
              className={`mt-3 rounded-md border px-3 py-2 text-sm ${
                testResult.success
                  ? "border-paper-300 bg-paper-100 text-ink-700"
                  : "border-[#9a2f22]/30 bg-[#9a2f22]/10 text-[#9a2f22]"
              }`}
            >
              <span className="font-medium">{testResult.success ? "成功" : "失败"}：</span>
              <span className="break-all">{testResult.message}</span>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
