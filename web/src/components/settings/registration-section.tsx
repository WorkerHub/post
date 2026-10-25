import { useCallback, useEffect, useState } from "react";
import { UserPlus } from "lucide-react";

import { adminApi } from "@/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useRegistrationStore } from "@/store/registration";

// 注册开关区（ONE-336，消费 B1 / ONE-330 冻结契约，见 api/admin.ts）：
// GET /api/admin/registration 读当前值（默认开启），Switch 切换即 POST { enabled } 落库，
// 展示后端返回的真实生效值。写入失败保持原值不回弹，错误原文直接给出。
// 成功后同步回写全局注册状态 store：登录页「注册」入口与注册页表单立即随之隐藏 / 恢复。
export function RegistrationSection() {
  const setRegistrationEnabled = useRegistrationStore((s) => s.setEnabled);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const state = await adminApi.getRegistration();
      setEnabled(state.enabled);
      setRegistrationEnabled(state.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [setRegistrationEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const state = await adminApi.updateRegistration(next);
      setEnabled(state.enabled);
      setRegistrationEnabled(state.enabled);
      setNotice(
        state.enabled
          ? "注册已开启：注册页恢复表单，登录页重新显示注册入口。"
          : "注册已关闭：直接访问 /register 显示「注册已关闭」，登录页不再显示注册入口。",
      );
    } catch (err) {
      // 写入失败：开关保持原值（不误翻），错误原文直接给出
      setError(err instanceof Error ? err.message : "开关保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>注册开关</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <label
              htmlFor="registration-switch"
              className="flex items-center gap-1.5 text-sm font-medium text-ink-700"
            >
              <UserPlus className="size-4 text-seal-500" />
              允许新用户注册
            </label>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              关闭后登录页不再显示注册入口，直接访问{" "}
              <code className="font-mono">/register</code> 显示「注册已关闭，暂不接受新用户注册」，
              后端注册接口同时拒绝（403）。重新开启即恢复。默认开启。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-ink-600">
              {loading
                ? "读取中…"
                : enabled === null
                  ? "读取失败"
                  : enabled
                    ? "已允许注册"
                    : "已关闭注册"}
            </span>
            <Switch
              id="registration-switch"
              checked={enabled === true}
              disabled={loading || saving || enabled === null}
              onCheckedChange={(checked) => void toggle(checked)}
              aria-label="注册开关"
            />
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600"
          >
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
            {notice}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
