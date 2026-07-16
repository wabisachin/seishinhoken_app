import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "精神保健福祉士 試験対策",
  description: "教科書RAGによる問題生成・演習アプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="bg-indigo-700 text-white">
          <nav className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3">
            <Link href="/" className="text-lg font-bold">
              精神保健福祉士 試験対策
            </Link>
            <div className="flex gap-4 text-sm">
              <Link href="/quiz" className="hover:underline">演習</Link>
              <Link href="/stats" className="hover:underline">成績</Link>
              <Link href="/settings" className="hover:underline">設定</Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
