import type { Metadata } from "next";
import { Zen_Maru_Gothic } from "next/font/google";
import "./globals.css";

// 丸みのある字形で「やさしさ」を出すため、見出し・本文とも同じファミリーで統一している
const zenMaru = Zen_Maru_Gothic({
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
  variable: "--font-zen-maru",
  display: "swap",
});

export const metadata: Metadata = {
  title: "精神保健福祉士 試験対策",
  description: "教科書RAGによる問題生成・演習アプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={zenMaru.variable}>
      <body>{children}</body>
    </html>
  );
}
