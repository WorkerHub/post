import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  Cloud,
  ExternalLink,
  Layers,
  Mail,
  Server,
  Tag,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { APP_BUILD_TIME, APP_VERSION } from "@/lib/version";

// 关于页（ONE-337 / post v1.1 #4）：公开页，挂在 RequireAuth 之外，未登录可直接访问。
// 版本号与构建时间只从 lib/version.ts 读（构建期 __APP_VERSION__ / __APP_BUILD_TIME__ 注入），
// 不在本页写死；产品名与 web/index.html 的 <title> 文案保持一致。
export const PRODUCT_NAME = "时光邮局";
export const PRODUCT_TAGLINE = "小圈子多用户的定时寄信服务";
export const REPO_URL = "https://github.com/WorkerHub/post";

const INTRO =
  "写下想说的话，挑一个未来的日期，到那天它会自动寄到对方的邮箱。信可以只寄给指定的人，也可以公开到信墙，让路过的人一起读。";

/** 技术栈按「运行时 / 后端 / 前端」分组，条目取自仓库实际依赖（package.json、wrangler.toml）。 */
const TECH_STACK: { title: string; icon: typeof Server; items: string[] }[] = [
  {
    title: "运行时与存储",
    icon: Cloud,
    items: [
      "Cloudflare Workers（计算、Cron 定时调度：每 5 分钟扫一次待寄信件）",
      "Workers Static Assets（托管 web 构建产物）",
      "Cloudflare D1（SQLite 数据库，表名带前缀）",
      "Cloudflare KV（会话、两步验证与限流计数）",
    ],
  },
  {
    title: "后端",
    icon: Server,
    items: [
      "Hono + TypeScript",
      "Web Crypto（JWT 会话签名）",
      "sanitize-html（信件正文消毒）",
      "SimpleWebAuthn（Passkey 登录）",
      "自建 SMTP 传输（cloudflare:sockets，配置存管理后台）",
    ],
  },
  {
    title: "前端",
    icon: Layers,
    items: [
      "React 19 + Vite + TypeScript",
      "Tailwind CSS v4（信纸风格设计令牌）",
      "Zustand（登录态与初始化状态）",
      "React Router（公开页与登录后工作台分流）",
      "Tiptap / ProseMirror（富文本写信）",
      "Radix UI（无样式基础组件）",
      "Lucide 图标、Motion 动画",
    ],
  },
];

/**
 * ISO 构建时刻 → `YYYY-MM-DD HH:mm:ss UTC` 展示串。
 * 仅做展示层裁剪（去掉毫秒与 T/Z），来源仍是 `__APP_BUILD_TIME__`；
 * 格式异常时原样返回，绝不伪造时间。
 */
export function formatBuildTime(iso: string): string {
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return matched ? `${matched[1]} ${matched[2]} UTC` : iso;
}

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Tag;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
      <dt className="inline-flex min-w-24 items-center gap-1.5 text-sm text-ink-500">
        <Icon className="size-4 shrink-0 text-seal-500" />
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-sm break-words text-ink-900">{children}</dd>
    </div>
  );
}

export default function AboutPage() {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-paper-300 bg-paper-50">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 text-ink-900">
            <Mail className="size-5 text-seal-500" />
            <span className="font-serif text-lg font-semibold">{PRODUCT_NAME}</span>
          </Link>
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              <ArrowLeft className="size-4" />
              返回首页
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12">
        <section className="text-center">
          <h1 className="font-serif text-4xl font-semibold tracking-wide">
            {PRODUCT_NAME}
          </h1>
          <p className="mt-3 text-base text-ink-600">{PRODUCT_TAGLINE}</p>
          <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-ink-700">
            {INTRO}
          </p>
        </section>

        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2">
          {TECH_STACK.map(({ title, icon: Icon, items }) => (
            <Card key={title}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="size-4 text-seal-500" />
                  {title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm leading-relaxed text-ink-700">
                  {items.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span aria-hidden className="text-seal-500">
                        ·
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">源码</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-ink-700">
                本站以开源方式维护，欢迎自建一套给自己的小圈子，或提交问题与建议。
              </p>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-seal-600 underline-offset-4 hover:underline"
              >
                <ExternalLink className="size-4" />
                github.com/WorkerHub/post
              </a>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-5">
          <CardHeader>
            <CardTitle className="text-base">构建信息</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-paper-200">
              <MetaRow icon={Tag} label="版本号">
                <span className="font-mono">{APP_VERSION}</span>
              </MetaRow>
              <MetaRow icon={Clock} label="构建时间">
                <time dateTime={APP_BUILD_TIME} className="font-mono">
                  {formatBuildTime(APP_BUILD_TIME)}
                </time>
              </MetaRow>
            </dl>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t border-paper-300 py-6 text-center text-xs text-ink-500">
        {APP_VERSION} · <Link to="/" className="underline-offset-4 hover:underline">回到首页</Link>
      </footer>
    </div>
  );
}
