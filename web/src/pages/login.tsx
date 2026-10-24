export default function LoginPage() {
  // 登录页在后续单实现（密码 + TOTP / Passkey，照 eNotify 形态）
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-[6px] border border-paper-300 bg-paper-50 p-8 text-center shadow-[0_1px_3px_rgba(58,53,42,0.08)]">
        <h1 className="font-serif text-xl font-semibold">登录时光邮局</h1>
        <p className="mt-2 text-sm text-ink-600">
          登录功能在后续任务中实现，当前为路由骨架占位。
        </p>
      </div>
    </div>
  );
}
