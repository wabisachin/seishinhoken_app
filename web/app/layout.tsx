import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "精神保健福祉士 試験対策",
  description: "教科書RAGによる問題生成・演習アプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
