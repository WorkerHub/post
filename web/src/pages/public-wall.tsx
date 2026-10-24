import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Mail, Feather, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fetchPublicLetters } from "@/api/public";
import type { PublicLetter } from "@/api/types";
import { SAMPLE_LETTERS, buildMockResponse } from "@/data/sample-letters";
import { formatDate, maskEmail } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";

const SITE_INTRO = "写一封信，寄往未来的某一天。";

function LetterCard({
  letter,
  isSample,
}: {
  letter: PublicLetter;
  isSample?: boolean;
}) {
  const authorName = letter.author_name || "一位朋友";
  return (
    <Card className="relative bg-[linear-gradient(180deg,var(--color-paper-50)_85%,var(--color-paper-100))]">
      {isSample && (
        <Badge className="absolute top-4 right-4 border-seal-500/30 bg-seal-500/10 text-seal-600">
          示例
        </Badge>
      )}
      <CardHeader>
        <CardTitle>{letter.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* 长正文截断（SPEC §6「可截断」）：限高溢出隐藏 + 底部纸张色渐隐 */}
        <div className="relative max-h-60 overflow-hidden">
          {/* body_html 为后端消毒后的内容，直接渲染，不开放原始 HTML */}
          <div
            className="font-serif text-sm leading-relaxed text-ink-700 [&_a]:text-seal-600 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-paper-300 [&_blockquote]:pl-3 [&_blockquote]:text-ink-500 [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc"
            dangerouslySetInnerHTML={{ __html: letter.body_html }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-paper-50 to-transparent"
          />
        </div>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 text-xs text-ink-500">
        <span>
          {letter.sent_at ? "寄出于" : "写于"}{" "}
          {formatDate(letter.sent_at ?? letter.created_at)}
          {letter.send_at && !letter.sent_at && (
            <> · 将于 {formatDate(letter.send_at)} 送达</>
          )}
        </span>
        <span>
          {authorName} → {maskEmail(letter.recipient_masked)}
        </span>
      </CardFooter>
    </Card>
  );
}

export default function PublicWallPage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [data, setData] = useState<{
    total_sent: number;
    letters: PublicLetter[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPublicLetters();
        if (!cancelled) setData(result);
      } catch {
        // 后端公开接口就绪前 fetch 失败时兜底为首访空墙 mock，
        // 由 SAMPLE_LETTERS 补位；后端就绪后移除本 catch 分支。
        if (!cancelled) setData(buildMockResponse());
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // 登录后 `/` 切「我的信件」工作台
  if (isAuthenticated) {
    return <Navigate to="/letters" replace />;
  }

  const letters = data?.letters ?? [];
  // 真实公开信不足 3 封时，从静态示例常量直接补位；满 3 封完全让位
  const samples = SAMPLE_LETTERS.slice(0, Math.max(0, 3 - letters.length));

  return (
    <div className="min-h-dvh">
      <header className="border-b border-paper-300 bg-paper-50">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <div className="flex shrink-0 items-center gap-2 text-ink-900">
            <Mail className="size-5 text-seal-500" />
            <span className="font-serif text-lg font-semibold">时光邮局</span>
          </div>
          <Button asChild variant="default" size="sm">
            <Link to="/login">
              <Feather className="size-4" />
              写给未来的自己
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-12">
        <section className="text-center">
          <h1 className="font-serif text-4xl font-semibold tracking-wide">
            时光邮局
          </h1>
          <p className="mt-3 text-lg text-ink-600">{SITE_INTRO}</p>
          <p className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-500">
            <Send className="size-4 text-seal-500" />
            已寄出{" "}
            <span className="font-medium text-ink-900">
              {data?.total_sent ?? "—"}
            </span>{" "}
            封信
          </p>
        </section>

        <section className="mt-12">
          <h2 className="sr-only">公开信墙</h2>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {letters.map((letter: PublicLetter) => (
              <LetterCard key={letter.id} letter={letter} />
            ))}
            {samples.map((letter) => (
              <LetterCard key={letter.id} letter={letter} isSample />
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-paper-300 py-6 text-center text-xs text-ink-500">
        时光邮局 · post.oneboy.app — 小圈子多用户的定时寄信服务
      </footer>
    </div>
  );
}
