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
      <h1 className="text-xl font-bold">ガイド</h1>

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
              出題します。
            </p>
          </div>
          <div>
            <p className="font-medium text-stone-900">③ 復習モード</p>
            <p className="mt-1">
              科目別演習・全科目演習で間違えた問題は自動的にここに溜まります。科目を選ぶか全科目からまとめて、
              間違えた回数が多いものほど優先的に再出題されます。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">🔬 AIによる問題生成のしくみ</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          このアプリの問題は、実際の教科書と過去問データをもとに、AIがそのつど新しく作成しています。
          「AIが作った問題」と聞くと、内容が不正確だったり、本番の試験とかけ離れた雰囲気に
          なったりしないか不安に思うかもしれません。実際にどういう手順で1問ができあがるのか、
          流れを図解します。
        </p>
        <div className="mt-4 space-y-2">
          <GenStep emoji="📖" title="教科書を全ページ読み込んである">
            使っている教科書は<strong className="font-bold">「最新社会福祉士養成講座 精神保健福祉士養成講座」（共通科目・全12巻）</strong>と
            <strong className="font-bold">「最新精神保健福祉士養成講座」（専門科目・全6巻）</strong>
            （どちらも中央法規出版）です。この2シリーズを全ページ読み込み、内容ごとに検索できる
            形にしてあります。
          </GenStep>
          <CycleArrow />
          <GenStep emoji="🔍" title="出題する単元を決め、教科書の該当箇所を探し出す">
            国家試験の出題基準に沿って、その科目の中でまだあまり出題していない単元を優先的に選びます。
            ただ、単元名（例:「認知症のBPSDへの対応」）だけで教科書の該当ページを検索しようとしても、
            言葉が短すぎてうまく探し出せません。そこでAIにまず「この単元について教科書に書いてありそうな
            解説文」を仮に250字程度で書かせ、その仮の文章を手がかりに教科書本文を検索します（仮の答えを
            "おとり"にして本物を探す、という検索の工夫です）。この仮の解説文自体は問題の材料には一切使わず、
            実際に問題の根拠になるのは、この検索で見つかった教科書の本物の文章だけです。
          </GenStep>
          <CycleArrow />
          <GenStep emoji="📊" title="過去問データから「今回の問題の型」を決める">
            過去2回分・18科目・264問の過去問をすべて分析し、科目ごとに「事例形式か知識説明形式か」
            「選択肢は説明文か用語か」「正答は1つか2つか」の出現比率を統計として持っています。今回
            作る1問についても、この統計に沿ってランダムに型を決めるので、出題形式が偏らず、本番の
            出題傾向に近い分布になります。
          </GenStep>
          <CycleArrow />
          <GenStep emoji="📚" title="実際の過去問を「お手本」として読み込ませる">
            型が決まったら、その型に一致する実際の過去問を最大5問、問題文・選択肢・正答まで
            そのままAIに見本として読み込ませます（同じ科目の過去問を優先し、数が足りない分だけ
            他科目の同じ型の過去問で補います）。「事例形式で作ってください」という指示の言葉だけ
            ではなく、「本番の問題は実際にこういう書き方・こういう言い回しをしている」という
            具体例を毎回見せることで、文体や難易度が本番の過去問からずれにくくなります。
          </GenStep>
          <CycleArrow />
          <GenStep emoji="✍️" title="見つかった教科書の本文だけを根拠に、AIが問題を作成する">
            <p>
              このとき、AIには細かいルールを指示しています。実際の指示の一部を、わかりやすく言い換えると:
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                受験者が実際に画面で見るのは問題文・事例文・選択肢の3つだけなので、「上記の文章によれば」
                のような、実際には見えていない何かを前提にした問題は作らない
              </li>
              <li>
                正解の選択肢だけを「〜な場合もある」のような曖昧な言い回しで逃げない。不正解の選択肢も、
                正解と同じくらい自信を持って言い切った書き方にする（文体の違いだけで正解がわかって
                しまわないようにするため）
              </li>
              <li>
                不正解の選択肢は、似た概念のすり替え・実在の人物と業績の取り違え・制度や法律の数値の
                すり替えなど、教科書に実在する別の内容を材料にする（存在しない話をでっち上げない）
              </li>
            </ul>
          </GenStep>
          <CycleArrow />
          <GenStep emoji="🔀" title="選択肢の並び順をシャッフルする">
            AIは無意識に正解を1番目の選択肢に置きがちな癖があることが、実際のデータ分析（708問中333問
            ＝47%が1番目に集中。ランダムなら本来20%程度のはず）でわかりました。そのため、AIが作った後に
            プログラム側で選択肢の並び順を強制的にシャッフルし、位置の偏りを無くしています。
          </GenStep>
          <CycleArrow />
          <GenStep emoji="✅" title="別のAIがもう一度検査し、合格した問題だけをストックする">
            作られた問題は、そのままストックされるのではなく、別の視点でもう一度AIにチェックさせます。
            「正解は教科書の記述で本当に裏付けられているか」「不正解の選択肢は本当に誤りと言い切れるか」
            「内容を知らなくても文体だけで正解がわかってしまわないか」などを確認し、この検査に通った
            問題だけが実際に出題される問題としてストックに追加されます（通らなければ書き直すか破棄され、
            出題されません）。解説の下に表示される「教科書の根拠」は、この時に実際に使われた教科書の
            抜粋そのものです。教科書PDFの都合で、まれに文字が読みにくくなっている箇所がありますが、
            問題や解説自体の正しさには影響しません。
          </GenStep>
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
          <p className="font-medium text-stone-900">📦 科目ごとの問題ストックには上限があります（科目別演習・全科目演習の場合）</p>
          <p className="mt-1.5">
            裏側では常に「まだ解いていない問題を5問前後」用意しておく仕組みになっていて、あなたが
            解き進めて手持ちの未解答分が減るたびに、AIが新しい問題を作って補充します。つまりその
            科目の<strong className="font-bold">問題プールの数（これまでに作られた問題の総数）</strong>が
            増えていくのは、あなたがその科目を使う（解き進める）ことが引き金になっています。問題プールの
            数は最大200問まで増え、200問に達するとAIによる新規作成はそこで完全に停止します。
          </p>
          <p className="mt-1.5">
            あなた自身がまだ解いたことのない問題に出会える割合は、この問題プールの数が増えるほど
            少しずつ下がっていきます（プール0問のときはほぼ100%、100問で約50%、150問で下限の
            25%に達し、そこから200問まではずっと25%のままです）。200問に達すると新規作成そのものが
            止まるため、出会う割合は実質0%になります。それ以降は、出題のたびに必ず、すでに解いた
            ことのある問題からの再出題になります。
          </p>
          <p className="mt-1.5">
            演習モード（科目別演習・全科目演習）で出題される「すでに解いたことのある問題」には、復習プールや
            想起の庭プールの問題も含まれます。1回正解しただけの問題を完全に出題対象から外すことはしません。
            間違えた問題を効率よく記憶に定着させつつ、「たまたま1回正解しただけ」かもしれない問題にも触れ続け、
            試験範囲全体をまんべんなくカバーできるようにするバランスです。
          </p>
          <p className="mt-1.5 text-xs text-stone-500">
            ※ この200問の上限は演習モード（科目別演習・全科目演習）だけのルールです。実戦模試の問題プールに
            上限は無く、その代わり「月5回まで」という受験回数の制限でペースを管理しています。
          </p>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">🎯 実戦模試について</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          科目別演習・全科目演習が「1問ずつ理解しながら進める」練習だとすると、実戦模試は
          「本番でどれだけ通用するか」を測る場所です。共通84問（140分）・専門48問（90分）という
          本番と同じ出題数・時間制限で解き、採点も総得点だけでなく、
          <strong className="font-bold">9つの科目群すべてで最低1問正解しているか</strong>という本番の
          合格基準をそのまま再現して判定します。「総得点は足りているのに、ある科目群がまるごと
          ゼロ点で不合格」という、普段の演習だけでは気づきにくい失敗パターンに事前に気づけます
          （詳しくは合格ガイドを参照）。
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          出題される問題は、科目別演習・全科目演習とは別に用意された実戦模試専用の問題プールから
          選ばれます（そのため実戦模試を受けても、科目別演習側の200問の上限には影響しません）。
          一方で、<strong className="font-bold">間違えた問題は科目別演習・全科目演習と同じように
          自動的に復習の対象になり</strong>、克服して2週間経てば想起の庭にも巡ってきます。実戦模試だけを
          特別扱いして復習から切り離す、ということはしていません。ペース管理のため、受験は月5回までに
          制限しています。
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
          グラフを見ると、想起の庭で正解した直後に保持率が回復するだけでなく、その後の
          下がり方も1回目より緩やかになっています。これは、人の記憶は一度「思い出せた」を
          経験するたびに定着していき、次に忘れるまでの時間がだんだん長くなる（忘れにくく
          なっていく）という性質があるためです。つまり、想起の庭で再び正解できた問題は、
          最初に覚えたときよりも忘れにくい記憶に育っている、というイメージです。
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          想起の庭は、この考え方に基づき、<strong className="font-bold">克服してから2週間以上経った問題</strong>
          を全分野横断で再テストする場所です（復習モードの選択画面から入れます）。克服が
          古い（＝対象になってから長く経っている）問題から順に出題されます。対象問題が
          30問に満たない間はまだ選べません。想起の庭でもし間違えたら、その問題は通常の
          復習ストックに戻り、また正解を目指すことになります。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">🤖 「おすすめの次の一手」の決め方</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          ホーム画面のおすすめは、以下の考え方を優先順位の高い順にAIが確認しながら、
          今のあなたの状況に一番合う行動を1つだけ選んで提案しています。
        </p>
        <div className="mt-3">
          <RankStep n={1} condition="まだ一度も演習していない・判断材料が少ない科目が全体的に多い" action="全科目演習（共通科目・専門科目のうち手薄な方）" note="対象を1つに絞れないため、広く判断材料を集めることを優先" />
          <RankStep n={2} condition="前回の実戦模試で0点だった科目群がある" action="その中で一番弱い科目を科目別演習" note="合格基準に直結するため最優先で対応" />
          <RankStep n={3} condition="実戦模試（未知の問題）での正答率が低い科目がある" action="その科目を科目別演習" note="演習だけでは見えない「対応力不足」への対処" />
          <RankStep n={4} condition="科目の未出題ストックが薄い科目がある" action="1〜2件程度なら最もストックが薄い科目を科目別演習、3件以上と広範囲なら全科目演習" note="対象を絞れる場合は、その科目を訪れること自体がストック補充のきっかけになる" />
          <RankStep n={5} condition="想起の庭の対象問題がある（30問以上）" action="想起の庭で忘れかけている問題を再テスト" note="下の「苦手科目の復習で潰す」より優先度が高い（ただし連続提案は避ける）" />
          <RankStep n={6} condition="間違えたまま残っている問題が多い苦手科目トップ3がある" action="科目別演習、または復習モード" note="判断材料が十分なら復習モード、不足していれば科目別演習を優先。ただし復習が60問以上溜まっていれば判断材料が少なくても復習モードを優先" />
          <RankStep n={7} condition="他の科目に比べて演習量が相対的に少なめの科目がある" action="1〜2件程度なら最も演習量が少ない科目を科目別演習、3件以上と広範囲なら全科目演習" />
          <RankStep n={8} condition="実戦模試を受けられる状況（月内のペース配分も考慮）" action="実戦模試で力試し" />
          <RankStep n={9} condition="上記のいずれにも当てはまらない" action="全科目演習を継続" />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-stone-400">
          実際の判断はAIが行い、上記の考え方を基本の軸にしつつ、学習プランの遅れ具合などその場の状況も
          踏まえて柔軟に判断します。毎回まったく同じ提案ばかりにならないよう、時には気分転換として
          別の選択肢を提案することもあります。
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
        <h2 className="font-bold text-indigo-700">教科書検索について</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          「見て覚える！国試ナビ」はイラスト中心で図解がわかりやすい教材です。調べたい言葉を
          入力すると、意味の近いページを画像で見つけて表示します。解説画面でも、関連する
          国試ナビのページがあれば「関連する国試ナビのページ」として自動的に案内されます。
        </p>
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
        <h2 className="font-bold text-indigo-700">「問題を準備しています」と出たら</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          このアプリはAIが問題を書き上げていますが、各科目とも「まだ出したことのない問題」を
          常に何問か裏側でストックしておく仕組みになっているため、通常はこの画面を見ることは
          ほとんどありません。ストックがたまたま切れているタイミングなど、まれにその場で
          新しい問題を用意することがあり、その場合だけ20〜40秒ほどかかります。表示されたら
          少しだけそのままお待ちください。自動的に問題が表示されます。
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

function GenStep({ emoji, title, children }: { emoji: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border-l-4 border-indigo-400 bg-indigo-50/40 p-4">
      <p className="font-bold text-stone-900">
        {emoji} {title}
      </p>
      <div className="mt-1.5 text-sm leading-relaxed text-stone-700">{children}</div>
    </div>
  );
}

function RankStep({
  n,
  condition,
  action,
  note,
}: {
  n: number;
  condition: string;
  action: string;
  note?: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
        {n}
      </div>
      <div className="flex-1 pb-3">
        <p className="text-sm text-stone-700">{condition}</p>
        <p className="mt-1 text-xs font-medium text-indigo-600">→ {action}</p>
        {note && <p className="mt-0.5 text-xs text-stone-400">{note}</p>}
      </div>
    </div>
  );
}
