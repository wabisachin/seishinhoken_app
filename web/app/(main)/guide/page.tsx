"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getStoredProfile, type UserProfile } from "@/lib/profile";
import ForgettingCurve from "./ForgettingCurve";

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
              共通科目（12科目）・専門科目（6科目）のどちらかを選び、その科目群を1問ずつ横断で
              出題します。科目別演習と同じく1問ずつ答えるとすぐ解答・解説が表示され、次の問題へ
              進みます。最後まで解き終えると正答数・正答率が表示されます（詳しい対応力の計測は
              実戦模試の役割です）。
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
        <h2 className="font-bold text-indigo-700">学習サイクルの全体像</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          解いた問題は、正解・誤答に応じて自動的に次のプールへ移っていきます。全体の流れは次の通りです。
        </p>
        <div className="mt-4 space-y-2">
          <CycleStage
            emoji="📝"
            title="科目別演習・全科目演習"
            subtitle="新しい問題、またはすでに解いたことのある問題を抽選で出題"
            color="indigo"
          >
            <CycleBranch tone="good" to="そのまま（また出題対象に残ります）" />
            <CycleBranch tone="bad" to="復習プールへ" />
          </CycleStage>
          <CycleArrow />
          <CycleStage
            emoji="🔁"
            title="復習プール"
            subtitle="「間違えたまま残っている問題」。間違えた回数が多いものほど優先的に出題"
            color="amber"
          >
            <CycleBranch tone="good" to="想起の庭プールへ（2週間は出題対象から外れます）" />
            <CycleBranch tone="bad" to="復習プールに残り続けます" />
          </CycleStage>
          <CycleArrow />
          <CycleStage
            emoji="🌱"
            title="想起の庭プール"
            subtitle="「克服してから2週間以上たった問題」。対象になったのが古い問題から出題"
            color="emerald"
          >
            <CycleBranch tone="good" to="再び2週間の待機へ（このサイクルを繰り返します）" />
            <CycleBranch tone="bad" to="復習プールに戻ります" />
          </CycleStage>
        </div>
        <div className="mt-4 rounded-xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-700">
          <p className="font-medium text-stone-900">📦 科目ごとの問題ストックには上限があります</p>
          <p className="mt-1.5">
            科目ごとにAIが新しく問題を作り続け、最大200問まで貯まります。200問に達すると新規作成は止まり、
            以降はこの200問の中からの出題だけになります。新しい問題に出会える割合は、貯まった問題数が
            増えるほど少しずつ下がっていきます（0問のときはほぼ100%、100問で約50%、200問以降は最低ラインの
            25%で下げ止まります）。
          </p>
          <p className="mt-1.5">
            演習モード（科目別演習・全科目演習）で出題される「すでに解いたことのある問題」には、復習プールや
            想起の庭プールの問題も含まれます。1回正解しただけの問題を完全に出題対象から外すことはしません。
            間違えた問題を効率よく記憶に定着させつつ、「たまたま1回正解しただけ」かもしれない問題にも触れ続け、
            試験範囲全体をまんべんなくカバーできるようにするバランスです。
          </p>
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

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-emerald-700">🌱 想起の庭について</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          間違えた問題は、同じ問題で正解すると「克服」したとみなされ、復習の対象から
          外れます。しかし人の記憶は時間とともに薄れていくもの（忘却曲線）で、一度克服した
          問題も、時間が経てば忘れている可能性があります。
        </p>
        <div className="mt-3">
          <ForgettingCurve />
        </div>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          想起の庭は、この考え方に基づき、<strong className="font-bold">克服してから2週間以上経った問題</strong>
          を全分野横断で再テストする場所です（復習モードの選択画面から入れます）。克服が
          古い（＝対象になってから長く経っている）問題から順に出題されます。対象問題が
          30問に満たない間はまだ選べません。想起の庭でもし間違えたら、その問題は通常の
          復習ストックに戻り、また正解を目指すことになります。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">学習の振り返りレポートについて</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          月が変わると、前月の学習を振り返るレポートが自動的に作られます。解いた問題数・
          新しく見つかった弱点・克服した弱点に加えて、間違え方の傾向（事例問題に弱い、
          似た名称を混同しやすい、など）を個々の問題まで踏み込んで分析し、次の月に取り組む
          べき科目・問題数を具体的な数値で提案します。成績ページの末尾から確認できます。
          新しいレポートができると、ホーム画面にお知らせが表示されます。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">🤖 「おすすめの次の一手」の決め方</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          ホーム画面のおすすめは、以下の考え方を優先順位の高い順にAIが確認しながら、
          今のあなたの状況に一番合う行動を1つだけ選んで提案しています。
        </p>
        <div className="mt-3 rounded-xl border-l-4 border-stone-300 bg-stone-50 p-3 text-sm text-stone-700">
          <span className="font-bold">最優先:</span> 前回途中で終えた演習があれば、他の何より先にその続きを提案します
        </div>
        <div className="mt-3">
          <RankStep n={1} condition="まだ一度も演習していない・判断材料が少ない科目が全体的に多い" action="全科目演習（共通科目・専門科目のうち手薄な方）" note="判断材料を広く集めることを優先" />
          <RankStep n={2} condition="前回の実戦模試で0点だった科目群がある" action="その中で一番弱い科目を科目別演習" note="合格基準に直結するため最優先で対応" />
          <RankStep n={3} condition="実戦模試（未知の問題）での正答率が低い科目がある" action="その科目を科目別演習" note="演習だけでは見えない「対応力不足」への対処" />
          <RankStep n={4} condition="科目の未出題ストックが薄い科目がある" action="全科目演習でストックを底上げ" />
          <RankStep n={5} condition="間違えたまま残っている問題が多い苦手科目トップ3がある" action="科目別演習、または復習モード" note="判断材料が十分なら復習モード、不足していれば科目別演習を優先。ただし復習が20問以上溜まっていれば判断材料が少なくても復習モードを優先" />
          <RankStep n={6} condition="他の科目に比べて演習量が相対的に少なめの科目がある" action="全科目演習で底上げ" />
          <RankStep n={7} condition="実戦模試を受けられる状況（月内のペース配分も考慮）" action="実戦模試で力試し" />
          <RankStep n={8} condition="上記のいずれにも当てはまらない" action="全科目演習を継続" isLast />
        </div>
        <div className="mt-3 space-y-1.5 rounded-xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-800">
          <p>
            🌱 想起の庭（対象30問以上で選べるようになります）は合否に直結する優先度が高くないため、
            他に優先すべき弱点が無く、しばらく実施していない場合の選択肢として提案されることがあります。
          </p>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-stone-400">
          実際の判断はAIが行い、上記の考え方を基本の軸にしつつ、学習プランの遅れ具合などその場の状況も
          踏まえて柔軟に判断します。毎回まったく同じ提案ばかりにならないよう、時には気分転換として
          別の選択肢を提案することもあります。
        </p>
      </section>
    </div>
  );
}

function CycleStage({
  emoji,
  title,
  subtitle,
  color,
  children,
}: {
  emoji: string;
  title: string;
  subtitle: string;
  color: "indigo" | "amber" | "emerald";
  children: React.ReactNode;
}) {
  const colorClass = {
    indigo: "border-indigo-400 bg-indigo-50/60",
    amber: "border-amber-400 bg-amber-50/60",
    emerald: "border-emerald-400 bg-emerald-50/60",
  }[color];
  return (
    <div className={`rounded-2xl border-l-4 p-4 ${colorClass}`}>
      <p className="font-bold text-stone-900">
        {emoji} {title}
      </p>
      <p className="mt-0.5 text-xs text-stone-500">{subtitle}</p>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}

function CycleBranch({ tone, to }: { tone: "good" | "bad"; to: string }) {
  return (
    <p
      className={`flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1 text-sm ${
        tone === "good" ? "bg-emerald-100/70 text-emerald-800" : "bg-red-100/70 text-red-800"
      }`}
    >
      <span className="font-bold">{tone === "good" ? "○ 正解" : "× 誤答"}</span>
      <span aria-hidden>→</span>
      <span className="text-stone-700">{to}</span>
    </p>
  );
}

function CycleArrow() {
  return (
    <div className="flex justify-center text-2xl leading-none text-stone-300" aria-hidden>
      ↓
    </div>
  );
}

function RankStep({
  n,
  condition,
  action,
  note,
  isLast,
}: {
  n: number;
  condition: string;
  action: string;
  note?: string;
  isLast?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
        {n}
      </div>
      <div className={`flex-1 pb-3 ${isLast ? "" : "border-b border-stone-100"}`}>
        <p className="text-sm text-stone-700">{condition}</p>
        <p className="mt-1 text-xs font-medium text-indigo-600">→ {action}</p>
        {note && <p className="mt-0.5 text-xs text-stone-400">{note}</p>}
      </div>
    </div>
  );
}
