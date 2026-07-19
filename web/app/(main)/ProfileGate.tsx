"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearStoredProfile, getStoredProfile, setStoredProfile, type UserProfile } from "@/lib/profile";

export default function ProfileGate({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null | "checking">("checking");
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    setProfile(getStoredProfile());
  }, []);

  // 応援する人にとっての「ホーム」は成績ページ。ブックマークやPWAのアイコンなど、
  // ナビのタブを経由せずに直接「/」へ来た場合（アプリを閉じて開き直した時など）に
  // 本人向けダッシュボードが一瞬でも見えてしまわないよう、成績ページへ流す
  useEffect(() => {
    if (profile === "guardian" && pathname === "/") {
      router.replace("/stats");
    }
  }, [profile, pathname, router]);

  function choose(p: UserProfile) {
    setStoredProfile(p);
    // router.push（クライアント側遷移）だと、layout.tsxに常駐しているHeaderNav
    // （ヘッダーのタイトルリンク・ナビタブ）がリマウントされず、プロフィールに応じた
    // 表示に切り替わらないまま古い状態で残ってしまう。ページ全体を読み込み直す
    // switchProfile()と同じ方式にして、ヘッダーも含め確実に切り替える
    window.location.href = p === "guardian" ? "/stats" : "/";
  }

  function switchToSelf() {
    clearStoredProfile();
    setProfile(null);
  }

  if (profile === "checking") return null;
  if (profile === "guardian" && pathname === "/") return null;

  if (profile === null) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-12">
        <h1 className="text-lg font-bold">はじめに、あなたについて教えてください</h1>
        <p className="text-sm leading-relaxed text-stone-600">
          ログインやパスワードは不要です。ご本人・動作テスト用・応援する人が同時にこのアプリを使っても、
          成績や復習の記録が混ざらないようにするための設定です。あとから画面右上でいつでも切り替えられます。
        </p>
        <div className="grid grid-cols-1 gap-3">
          <button
            onClick={() => choose("self")}
            className="rounded-2xl border-l-4 border-indigo-400 bg-white p-5 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-indigo-700">ご本人</h2>
            <p className="mt-1 text-sm text-stone-600">試験対策として問題を解きます</p>
          </button>
          <button
            onClick={() => choose("test")}
            className="rounded-2xl border-l-4 border-amber-400 bg-white p-5 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-amber-700">動作テスト用</h2>
            <p className="mt-1 text-sm text-stone-600">
              ご本人以外が動作確認のために自由に使えるモードです。記録はご本人とは別に保存されます
            </p>
          </button>
          <button
            onClick={() => choose("guardian")}
            className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-violet-700">応援する人</h2>
            <p className="mt-1 text-sm text-stone-600">成績を見るだけで、問題は解きません</p>
          </button>
        </div>
      </div>
    );
  }

  // 応援する人は演習・模試のページには入れない（成績を見るだけ、という約束を実際に守る）
  const isPracticeRoute = pathname.startsWith("/quiz") || pathname.startsWith("/full-mock");
  if (profile === "guardian" && isPracticeRoute) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-12 text-center">
        <h1 className="text-lg font-bold">問題を解けるのはご本人だけです</h1>
        <p className="text-sm leading-relaxed text-stone-600">
          「応援する人」は成績の確認だけができるモードです。進捗は成績ページで確認できます。
        </p>
        <div className="flex flex-col items-center gap-3">
          <a
            href="/stats"
            className="inline-flex min-h-12 items-center rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
          >
            成績を見る
          </a>
          <button onClick={switchToSelf} className="text-xs text-stone-400 underline underline-offset-2">
            ご本人として使う場合はこちら
          </button>
        </div>
      </div>
    );
  }

  // 動作テスト用は本番データと見た目が同じだと誤認しやすいため、常時わかるバナーを出す
  // （本人の学習データとはDB上完全に分離されているが、UI上でも明示しておく）
  if (profile === "test") {
    return (
      <>
        <div className="bg-amber-400 px-4 py-1.5 text-center text-xs font-bold text-amber-950">
          動作テスト用モードです（本人の学習データとは分けて記録されます）
        </div>
        {children}
      </>
    );
  }

  return <>{children}</>;
}
