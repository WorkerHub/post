import { useCallback } from "react";

import { settingsApi } from "@/api/client";
import { useAuthStore } from "@/store/auth";
import { ProfileSection } from "@/components/settings/profile-section";
import { SecuritySection } from "@/components/settings/security-section";
import { SmtpSection } from "@/components/settings/smtp-section";
import { UsersSection } from "@/components/settings/users-section";

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  // 保存/2FA 变更后刷新档案（含 twofa 状态与 role）
  const refresh = useCallback(async () => {
    const me = await settingsApi.getMe();
    setUser(me);
  }, [setUser]);

  if (!user) {
    return (
      <div>
        <h1 className="font-serif text-2xl font-semibold">设置</h1>
        <p className="mt-2 text-sm text-ink-600">正在加载账户信息…</p>
      </div>
    );
  }

  const isAdmin = user.role === "admin";

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">设置</h1>
      <p className="mt-1 text-sm text-ink-600">{user.email}</p>

      <div className="mt-6 space-y-6">
        <ProfileSection user={user} onSaved={() => void refresh()} />
        <SecuritySection user={user} onSaved={() => void refresh()} />
        {isAdmin && (
          <>
            <SmtpSection />
            <UsersSection currentUserId={user.id} />
          </>
        )}
      </div>
    </div>
  );
}
