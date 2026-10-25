import { MaintenanceSection } from "@/components/settings/maintenance-section";
import { RegistrationSection } from "@/components/settings/registration-section";
import { SmtpSection } from "@/components/settings/smtp-section";
import { UsersSection } from "@/components/settings/users-section";
import { useAuthStore } from "@/store/auth";

// 系统管理页（F3 / ONE-331）：SMTP 配置、注册开关、用户管理、系统维护四块，
// 仅 admin 可见可进（路由守卫见 components/require-admin.tsx）。
// 各块内容复用 settings/* 组件，内部业务逻辑不做改动（注册开关为 ONE-336 新增）。
export default function AdminPage() {
  const user = useAuthStore((s) => s.user);

  if (!user) {
    return (
      <div>
        <h1 className="font-serif text-2xl font-semibold">系统管理</h1>
        <p className="mt-2 text-sm text-ink-600">正在加载账户信息…</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">系统管理</h1>
      <p className="mt-1 text-sm text-ink-600">站点级配置与用户管理（仅管理员可见）</p>

      <div className="mt-6 space-y-6">
        <SmtpSection />
        <RegistrationSection />
        <UsersSection currentUserId={user.id} />
        <MaintenanceSection />
      </div>
    </div>
  );
}
