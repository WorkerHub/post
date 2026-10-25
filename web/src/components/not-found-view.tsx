import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * 404 视图（ONE-320）：管理员把 setup 页面开关关掉后，浏览器访问 `/setup`
 * 看到的就是这一页——不展示任何初始化相关内容，只回一个通用 404。
 */
export function NotFoundView() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-[6px] border border-paper-300 bg-paper-50 p-8 text-center shadow-[0_1px_3px_rgba(58,53,42,0.08)]">
        <p className="font-serif text-5xl font-semibold tracking-tight text-ink-900">404</p>
        <p className="mt-4 text-sm text-ink-700">页面不存在</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          这个地址没有对应的内容，或者已经被关闭了。
        </p>
        <Button asChild variant="outline" className="mt-6 w-full">
          <Link to="/">
            <ArrowLeft className="size-4" />
            返回首页
          </Link>
        </Button>
      </div>
    </div>
  );
}
