import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Send, Trash2 } from "lucide-react";

import { adminApi } from "@/api/client";
import type { ResendConfig } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { isValidEmail } from "@/lib/validation";

type Row = { key: string; domain: string; token: string; configured: boolean };

let rowSeq = 0;
function nextRowKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

/**
 * Resend 发信渠道配置（功能单，对齐 smtp-section 的独立 form 与脱敏口径）：
 * - 渠道二选一（SMTP 默认 / Resend），管理员选定后发信走对应通道。
 * - 按域名填 API key（{域名: token}）；token 脱敏回显，留空保存 = 不改。
 */
export function ResendSection() {
  const [config, setConfig] = useState<ResendConfig | null>(null);
  const [channel, setChannel] = useState<"smtp" | "resend">("smtp");
  const [rows, setRows] = useState<Row[]>([]);
  const [testTo, setTestTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await adminApi.getResend();
      setConfig(cfg);
      setChannel(cfg.channel);
      const domains = Object.keys(cfg.tokens_set);
      setRows(
        domains.map((d) => ({
          key: nextRowKey(),
          domain: d,
          token: "",
          configured: true,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRow = (key: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { key: nextRowKey(), domain: "", token: "", configured: false },
    ]);
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const save = async () => {
    setError(null);
    setNotice(null);

    const resend_tokens: Record<string, string> = {};
    for (const r of rows) {
      const domain = r.domain.trim();
      if (!domain) continue;
      // 新域名必须给 token（留空对后端是「不改」，等于没配）
      if (!r.configured && !r.token.trim()) {
        setError(`请填写 ${domain || "新增域名"} 的 API key`);
        return;
      }
      resend_tokens[domain] = r.token;
    }

    setSaving(true);
    try {
      await adminApi.updateResend({ channel, resend_tokens });
      setNotice("Resend 配置已保存");
      // 重新拉取，刷新脱敏视图与 configured 标记
      await load();
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
      setTestResult(await adminApi.testResend(testTo));
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : "发送失败",
      });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-ink-500">
          正在加载 Resend 配置…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resend 发信渠道</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          name="resend-config"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="mb-2 text-sm font-medium text-ink-700">发信渠道</p>
          <div className="flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-ink-800">
              <input
                type="radio"
                name="resend_channel"
                value="smtp"
                checked={channel === "smtp"}
                onChange={() => setChannel("smtp")}
              />
              SMTP（现有通道）
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-ink-800">
              <input
                type="radio"
                name="resend_channel"
                value="resend"
                checked={channel === "resend"}
                onChange={() => setChannel("resend")}
              />
              Resend（API 直连 + webhook 回写投递状态）
            </label>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-ink-700">按域名 API key</p>
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus className="size-3.5" />
                添加域名
              </Button>
            </div>
            {rows.length === 0 ? (
              <p className="text-xs text-ink-500">
                尚未配置任何发信域名；添加域名后填入 Resend API key。
              </p>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => (
                  <div key={r.key} className="flex flex-wrap items-center gap-2">
                    <Input
                      value={r.domain}
                      onChange={(e) => updateRow(r.key, { domain: e.target.value })}
                      placeholder="发信域名，如 someday.example.com"
                      aria-label="发信域名"
                      autoComplete="off"
                      className="min-w-40 flex-1"
                    />
                    <Input
                      type="password"
                      value={r.token}
                      onChange={(e) => updateRow(r.key, { token: e.target.value })}
                      placeholder={r.configured ? "已配置，留空表示不改" : "Resend API key（re_…）"}
                      aria-label="Resend API key"
                      autoComplete="off"
                      name="resend_token"
                      className="min-w-48 flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="删除该域名"
                      onClick={() => removeRow(r.key)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {config && Object.keys(config.tokens_set).length > 0 && (
              <p className="mt-2 text-xs text-ink-500">
                API key 已脱敏保存，不回显明文；留空保存表示不修改。
              </p>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600"
            >
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
              {saving ? "保存中…" : "保存 Resend 配置"}
            </Button>
          </div>
        </form>

        <form
          name="resend-test"
          className="border-t border-paper-200 pt-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void test();
          }}
        >
          <p className="mb-2 text-sm font-medium text-ink-700">发送测试邮件（经 Resend）</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="resend-test-to"
              name="resend_test_recipient"
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="Resend 测试收件邮箱"
              aria-label="Resend 测试收件邮箱"
              autoComplete="off"
              className="flex-1"
            />
            <Button type="submit" variant="outline" disabled={testing}>
              <Send className="size-4" />
              {testing ? "发送中…" : "发送 Resend 测试邮件"}
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
