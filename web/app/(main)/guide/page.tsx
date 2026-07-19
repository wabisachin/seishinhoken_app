"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getStoredProfile, type UserProfile } from "@/lib/profile";

export default function GuidePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    setProfile(getStoredProfile());
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">このアプリの使い方</h1>

      {/* 本人・動作テスト用はナビバー枠(5個まで)の都合で合格ガイドをバナーから外しているため、
          ここにリンクを置く。応援する人はバナーに合格ガイドが残っているので出さない */}
      {profile !== "guardian" && profile !== null && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="font-bold text-indigo-700">合格ガイド</h2>
          <p className="mt-2 text-sm leading-relaxed text-stone-700">
            合格基準・科目群ごとの得点のしくみなど、試験制度についての説明はこちらです。
          </p>
          <Link
            href="/pass-guide"
            className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700"
          >
            合格ガイドを見る
          </Link>
        </section>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">これは何？</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          精神保健福祉士の国家試験対策のための、練習問題アプリです。教科書や過去問をもとに、
          AIがそのつど新しい練習問題を作ってくれます。市販の問題集と違って、問題の数が
          決まっているわけではなく、使えば使うほど問題のストックが増えていきます。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">3つの使い方</h2>
        <div className="mt-3 space-y-4 text-sm leading-relaxed text-stone-700">
          <div>
            <p className="font-medium text-stone-900">① 科目別演習</p>
            <p className="mt-1">
              科目を1つ選んで、1問ずつじっくり解きます。答えるとすぐに正解と解説が表示されるので、
              1問ごとに理解しながら進められます。
            </p>
          </div>
          <div>
            <p className="font-medium text-stone-900">② 全科目演習</p>
            <p className="mt-1">
              全18科目から1問ずつ、まんべんなく出題されます。3問（3科目）を1セットとして解き、
              セットを解き終えるたびにその場で解答と解説が表示されます。全部で18問、進捗バーで
              残りがひと目でわかります。得点率などの結果レポートはありません
              （未知の問題への対応力を測るのは実戦模試の役割です）。
            </p>
          </div>
          <div>
            <p className="font-medium text-stone-900">③ 復習モード</p>
            <p className="mt-1">
              科目別演習・全科目演習で間違えた問題は自動的にここに溜まります。科目を選ぶか全科目からまとめて、
              間違えた回数が多いものほど優先的に再出題されます。この学習の最終ゴールは、ホーム画面に出る
              「間違えたまま残っている問題数」を0にすることです。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">「問題を準備しています」と出たら</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          このアプリはAIが問題を書き上げていますが、各科目とも「まだ出したことのない問題」を
          常に何問か裏側でストックしておく仕組みになっているため、通常はこの画面を見ることは
          ほとんどありません。ストックがたまたま切れているタイミングなど、まれにその場で
          新しい問題を用意することがあり、その場合だけ20〜40秒ほどかかります。表示されたら
          少しだけそのままお待ちください。自動的に問題が表示されます。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">使い込むほど、問題の出方が変わっていきます</h2>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-stone-700">
          <p>
            ある科目を使い始めたばかりのころは、出てくる問題はほぼ毎回まったくの新作です。
          </p>
          <p>
            その科目でだいぶ問題が貯まってくると、少しずつ「前に見たことのある問題」が
            混ざるようになります。真新しさより、たくさん練習できることを優先する切り替えです。
          </p>
          <p>
            さらに問題が十分な数まで貯まった科目については、それ以上の新作は作らなくなり、
            すでに貯まった問題の中から出題されるようになります。「もう問題が増えないな」と
            感じたら、その科目はしっかりストックが貯まったということです。
          </p>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">解いている途中でアプリを閉じてしまっても</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          科目別演習や全科目演習の途中でブラウザを閉じたり、リロードしてしまっても大丈夫です。
          次にそのモードを開いたときに「前回の続きから再開しますか？」という案内が出るので、
          そこから続けるか、新しく始めるかを選べます。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">教科書の根拠について</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          解説の下に「教科書の根拠」として、実際にその教科書から抜き出した文章が表示されます。
          古い教科書PDFの都合で、まれに文字が読みにくくなっている箇所がありますが、
          問題や解説自体の正しさには影響しません。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">教科書検索について</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          「見て覚える！国試ナビ」はイラスト中心で図解がわかりやすい教材です。調べたい言葉を
          入力すると、意味の近いページを画像で見つけて表示します。解説画面でも、関連する
          国試ナビのページがあれば「関連する国試ナビのページ」として自動的に案内されます。
        </p>
      </section>
    </div>
  );
}
