import { useCallback, useEffect, useState } from "react";
import { DatabaseZap, LockKeyhole } from "lucide-react";

import { adminApi } from "@/api/client";
import type { DbUpgradeResult } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Switch } from "@/components/ui/switch";

// 系统维护区（ONE-320，仅管理员渲染；契约见 api/admin.ts 与后端⑤ ONE-319）：
// 1) 「升级数据库」→ POST /api/admin/db-upgrade，程序升级后免 SETUP_SECRET 就地补齐表结构
//    （后端 ensureSchema 幂等，可重复执行），完成后展示摘要。
// 2) 「setup 页面开关」→ GET/POST /api/admin/setup-switch；OFF 后浏览器访问 /setup 呈现 404。
export function MaintenanceSection() {
  const [switchEnabled, setSwitchEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [result, setResult] = useState<DbUpgradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { enabled } = await adminApi.getSetupSwitch();
      setSwitchEnabled(enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runUpgrade = async () => {
    setConfirmOpen(false);
    setUpgrading(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const res = await adminApi.dbUpgrade();
      setResult(res);
      setNotice(res.success ? "数据库升级完成" : "数据库升级未成功");
    } catch (err) {
      setError(err instanceof Error ? err.message : "升级失败");
    } finally {
      setUpgrading(false);
    }
  };

  const toggleSwitch = async (next: boolean) => {
    setToggling(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApi.updateSetupSwitch(next);
      setSwitchEnabled(res.enabled);
      setNotice(
        res.enabled
          ? "setup 页面已开启：浏览器访问 /setup 恢复正常显示。"
          : "setup 页面已关闭：浏览器访问 /setup 现在呈现 404。",
      );
    } catch (err) {
      // 写入失败保持原值不回弹，错误原文直接给出
      setError(err instanceof Error ? err.message : "开关保存失败");
    } finally {
      setToggling(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>系统维护</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink-700">升级数据库</p>
          <p className="text-xs leading-relaxed text-ink-500">
            程序升级后在这里就地补齐数据库表结构与索引，无需再使用初始化密钥。可重复执行（幂等）。
          </p>
          <div className="flex justify-end">
            <Button onClick={() => setConfirmOpen(true)} disabled={upgrading}>
              <DatabaseZap className="size-4" />
              {upgrading ? "升级中…" : "升级数据库"}
            </Button>
          </div>
        </div>

        {result && (
          <div
            role="status"
            className={`rounded-md border px-3 py-2 text-sm ${
              result.success
                ? "border-paper-300 bg-paper-100 text-ink-700"
                : "border-[#9a2f22]/30 bg-[#9a2f22]/10 text-[#9a2f22]"
            }`}
          >
            <span className="font-medium">{result.success ? "成功" : "失败"}：</span>
            <span className="break-all">{result.message ?? (result.success ? "已完成。" : "未完成。")}</span>
            {result.summary.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {result.summary.map((item) => (
                  <li key={item.label} className="flex justify-between gap-3">
                    <span className="text-ink-500">{item.label}</span>
                    <span className="break-all font-mono text-ink-700">{item.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="border-t border-paper-200 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <label
                htmlFor="setup-switch"
                className="flex items-center gap-1.5 text-sm font-medium text-ink-700"
              >
                <LockKeyhole className="size-4 text-seal-500" />
                setup 页面开关
              </label>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                关闭后浏览器访问 <code className="font-mono">/setup</code> 呈现 404；重新开启即恢复。
                初始化已完成的本站平时应当关闭它。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-ink-600">
                {loading ? "读取中…" : switchEnabled ? "已开启" : "已关闭"}
              </span>
              <Switch
                id="setup-switch"
                checked={switchEnabled === true}
                disabled={loading || toggling || switchEnabled === null}
                onCheckedChange={(checked) => void toggleSwitch(checked)}
                aria-label="setup 页面开关"
              />
            </div>
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

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="升级数据库结构"
        description="将按当前生效的表前缀执行建表与索引语句，重复执行不会丢数据。仅在程序升级后需要执行。"
        confirmLabel="开始升级"
        loading={upgrading}
        onConfirm={() => void runUpgrade()}
      />
    </Card>
  );
}
