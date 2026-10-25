import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck, UserRound } from "lucide-react";

import { adminApi } from "@/api/client";
import type { AdminUser } from "@/api/admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function UsersSection({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await adminApi.listUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-ink-500">正在加载用户…</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>用户管理</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
            {error}
          </p>
        )}
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
        {users.map((u) => {
          const isSelf = u.id === currentUserId;
          const busy = busyId === u.id;
          const pending = u.approval_status === "pending";
          return (
            <div
              key={u.id}
              className="flex flex-col gap-3 rounded-[6px] border border-paper-300 bg-paper-50 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 font-medium text-ink-900">
                    {u.role === "admin" ? (
                      <ShieldCheck className="size-4 text-seal-500" />
                    ) : (
                      <UserRound className="size-4 text-ink-500" />
                    )}
                    {u.email}
                  </span>
                  {u.display_name && (
                    <span className="text-xs text-ink-500">（{u.display_name}）</span>
                  )}
                  {isSelf && <Badge>当前账号</Badge>}
                  {pending && (
                    <Badge className="border-seal-500/30 bg-seal-500/10 text-seal-600">待批准</Badge>
                  )}
                  {!u.is_active && <Badge>已禁用</Badge>}
                  {u.role === "admin" && <Badge>管理员</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  注册于 {u.created_at.slice(0, 10)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {pending && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(u.id, () => adminApi.approveUser(u.id))}
                  >
                    <CheckCircle2 className="size-3.5" />
                    批准
                  </Button>
                )}
                {u.role === "user" && !pending && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(u.id, () => adminApi.updateUser(u.id, { role: "admin" }))}
                  >
                    设为管理员
                  </Button>
                )}
                {u.role === "admin" && !isSelf && !pending && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(u.id, () => adminApi.updateUser(u.id, { role: "user" }))}
                  >
                    设为用户
                  </Button>
                )}
                {!pending &&
                  !isSelf &&
                  (u.is_active ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-ink-500 hover:text-[#9a2f22]"
                      disabled={busy}
                      onClick={() => void run(u.id, () => adminApi.updateUser(u.id, { is_active: false }))}
                    >
                      禁用
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(u.id, () => adminApi.updateUser(u.id, { is_active: true }))}
                    >
                      启用
                    </Button>
                  ))}
              </div>
            </div>
          );
        })}
        </div>
      </CardContent>
    </Card>
  );
}
