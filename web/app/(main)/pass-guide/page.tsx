import { EXAM_SUBJECT_COUNTS, EXAM_SUBJECT_GROUPS, EXAM_ROUND_LABEL, EXAM_DATE_START, EXAM_DATE_END, daysUntilExam } from "@/lib/examFormat";

// daysUntilExam()は「今」に依存するため、ビルド時に静的プリレンダリングされて
// 日数が固定化されないよう、このページを動的レンダリングに固定する。
export const dynamic = "force-dynamic";

const SUBJECT_GROUPS = EXAM_SUBJECT_GROUPS;

// 養成課程の標準履修時間（60時間科目は30時間科目の倍の分量が想定されている「本丸」科目）。
// 出題数・パート区分自体はexamFormat.tsのEXAM_SUBJECT_COUNTSと二重管理しない。
const HOURS_BY_SUBJECT: Record<string, 60 | 30> = {
  医学概論: 30,
  心理学と心理的支援: 30,
  社会学と社会システム: 30,
  社会福祉の原理と政策: 60,
  社会保障: 60,
  権利擁護を支える法制度: 30,
  地域福祉と包括的支援体制: 60,
  障害者福祉: 30,
  刑事司法と福祉: 30,
  ソーシャルワークの基盤と専門職: 30,
  ソーシャルワークの理論と方法: 60,
  社会福祉調査の基礎: 30,
  精神医学と精神医療: 60,
  現代の精神保健の課題と支援: 60,
  精神保健福祉の原理: 60,
  "ソーシャルワークの理論と方法(専門)": 60,
  精神障害リハビリテーション論: 30,
  精神保健福祉制度論: 30,
};
const SESSION_LABEL: Record<"common" | "specialized", string> = { common: "午前（共通）", specialized: "午後（専門）" };
const SUBJECT_COUNTS = EXAM_SUBJECT_COUNTS.map((s) => ({
  subject: s.subject,
  session: SESSION_LABEL[s.part],
  questions: s.questions,
  hours: HOURS_BY_SUBJECT[s.subject],
}));

export default function PassGuidePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">合格ガイド</h1>
      <p className="text-sm leading-relaxed text-stone-600">
        出題基準PDF・過去問（第27回・第28回）・厚生労働省の養成課程カリキュラム・合格基準発表資料をもとにまとめています。
        年度によって変わる数値（合格ラインの実際の点数など）は、直近の回の実績として記載しています。
      </p>

      <section className="rounded-2xl border-l-4 border-indigo-500 bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">次の本番</h2>
        <p className="mt-2 text-2xl font-bold text-stone-800">
          {EXAM_ROUND_LABEL}・あと{daysUntilExam()}日
        </p>
        <p className="mt-1 text-sm text-stone-600">
          {EXAM_DATE_START.replace(/-/g, "/")} 〜 {EXAM_DATE_END.slice(8)}日 実施予定
        </p>
        <p className="mt-2 text-xs text-stone-500">
          この試験日から逆算して、おすすめの次の一手・月次の学習プランを提案しています。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">この試験の全体像</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          全18科目・132問で構成され、午前（共通科目・社会福祉士と合同で受験）84問、午後（専門科目・精神保健福祉士のみ）
          48問の2部制です。共通科目免除者（社会福祉士登録者など）は共通科目を受けず、専門科目48問のみで判定されます。
        </p>
      </section>

      <section className="rounded-2xl border-l-4 border-red-400 bg-white p-5 shadow-warm">
        <h2 className="font-bold text-red-700">合格基準（最も重要）</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">次の2つの条件を、どちらも満たす必要があります。</p>
        <ol className="mt-3 space-y-3 text-sm leading-relaxed text-stone-700">
          <li>
            <span className="font-medium text-stone-900">① 総得点が一定以上であること</span>
            <br />
            目安は総得点の約60%ですが、その年の問題の難易度によって毎年調整されます。直近の第28回では
            <strong>132点中62点以上</strong>（共通科目免除者は48点中27点以上）が実際の合格ラインでした。
            「6割ちょうど取れば安全」ではなく、多少上振れ・下振れすることを念頭に、6割より余裕を持って
            得点できることを目標にするのが安全です。
          </li>
          <li>
            <span className="font-medium text-stone-900">② 科目群ごとに得点していること（1問も正解できない科目群があると、総得点に関係なく不合格）</span>
            <br />
            18科目は下の9つの「科目群」にまとめられており（共通科目免除者は5科目群）、
            <strong>すべての科目群で最低1問以上正解</strong>する必要があります。得意科目で高得点を取っても、
            苦手な科目群がまるごとゼロ点だと不合格になるということです。特定の科目だけ捨てる、という戦略は
            取れません。
          </li>
        </ol>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">9つの科目群</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          複数科目がまとめて1つの群になっているものがあります。群の中のどれか1科目で得点できていれば、
          その群はクリアです（例: ⑤は精神障害リハビリテーション論と精神保健福祉制度論のどちらかで正解すればよい）。
        </p>
        <ul className="mt-3 space-y-2 text-sm text-stone-700">
          {SUBJECT_GROUPS.map((g) => (
            <li key={g.label} className="flex gap-2">
              <span className="shrink-0 font-bold text-indigo-500">{g.label}</span>
              <span>{g.subjects.join("・")}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="overflow-x-auto rounded-2xl bg-white p-4 shadow-warm sm:p-5">
        <h2 className="mb-1 font-bold text-indigo-700">科目別の出題数・学習の重み目安</h2>
        <p className="mb-3 text-sm leading-relaxed text-stone-600">
          出題数は第28回の実績。時間は精神保健福祉士養成課程の標準履修時間で、60時間科目は30時間科目の倍の
          分量が想定されている、いわば「本丸」の科目です。学習時間の配分の参考にしてください。
        </p>
        <table className="w-full min-w-[420px] text-sm">
          <thead className="bg-stone-100 text-left">
            <tr>
              <th className="px-3 py-1.5">科目</th>
              <th className="px-3 py-1.5">午前/午後</th>
              <th className="px-3 py-1.5 text-right">出題数</th>
              <th className="px-3 py-1.5 text-right">養成課程の時間数</th>
            </tr>
          </thead>
          <tbody>
            {SUBJECT_COUNTS.map((s) => (
              <tr key={s.subject} className="border-t border-stone-100">
                <td className="px-3 py-1.5">{s.subject}</td>
                <td className="px-3 py-1.5 text-stone-500">{s.session}</td>
                <td className="px-3 py-1.5 text-right">{s.questions}問</td>
                <td className="px-3 py-1.5 text-right">
                  <span className={s.hours === 60 ? "font-medium text-indigo-700" : "text-stone-500"}>
                    {s.hours}時間
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">出題形式の傾向（本アプリの過去問分析より）</h2>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-stone-700">
          <p>
            第27回・第28回の過去問264問を全問精査したところ、出題形式は「事例文の有無」と「選択肢が
            用語か説明文か」という独立した2つの軸の組み合わせで決まります。
            <span className="font-medium">知識説明形式</span>
            （事例文なし・選択肢が完全な説明文、全体の約53%）が中心ですが、
            <span className="font-medium">事例形式</span>
            （「A精神保健福祉士」「Aさん」など匿名の専門職・クライエントの短い場面を読んで、適切な対応や
            該当する概念を選ぶ形式）も選択肢が説明文の場合・用語の場合それぞれ約16%ずつ（合計約31%）
            あり、科目によっては半数以上を占めます。
            <span className="font-medium">用語・名称選択形式</span>
            （選択肢が完全な説明文ではなく、病名・制度名・役職名などの短い用語そのものになっている形式。
            事例文なしが約16%、事例文ありが約16%で合計約31%。医学概論・精神医学と精神医療などの科目に
            偏って多く出ます。ごくまれに、用語とその属性（時期・分類等）のペアを1行ずつ選択肢に並べる
            形式もあります）も無視できない比率です。
          </p>
          <p>
            また、正答が1つの五肢択一が約76%、2つ選ぶ五肢択二が約24%です。事例形式は択一の比率がやや高く、
            択二は科目によって出やすさにばらつきがあります。このアプリの科目別演習・全科目演習は、
            これらの実際の比率に沿って出題形式を再現するようにしています。
          </p>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">よくある誤答（ひっかけ）のパターン</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          過去問110問以上の正答・誤答を照合して分析したところ、誤りの選択肢の作られ方には
          いくつかの型がありました。読んでいて「なんとなく合ってそう」と感じた選択肢ほど、
          次のどれかに当てはまっていないか疑ってみてください。
        </p>
        <ol className="mt-3 space-y-2 text-sm leading-relaxed text-stone-700">
          <li>
            <span className="font-medium text-stone-900">① 類似・隣接概念とのすり替え（最も多い）</span>
            <br />
            同じ分野の別の概念・分類・理論の説明を、問われている対象の説明であるかのように混ぜてくる。
            5つの選択肢すべてが実在する用語で、うち1つだけが本当に問いに合致する、という形が最頻出です。
          </li>
          <li>
            <span className="font-medium text-stone-900">② 人物と業績の取り違え</span>
            <br />
            人物名は実在の人物だが、その人が実際に行ったことではなく、別の人物の理論・功績・立場を
            割り当てている。
          </li>
          <li>
            <span className="font-medium text-stone-900">③ 制度・法律の主体／対象／要件のすり替え</span>
            <br />
            「誰が行うか」「対象になるのは誰か」「要件は何か」を、実際とは異なる別のもの
            （別の職種・別の機関・別の年齢層など）に置き換えている。
          </li>
          <li>
            <span className="font-medium text-stone-900">④ 数値・年号・期間の書き換え</span>
            <br />
            正しい記述の中の数字（年齢、年数、期間、比率、順位など）だけを変えている。
          </li>
          <li>
            <span className="font-medium text-stone-900">⑤ 過度な一般化・断定・除外</span>
            <br />
            「必ず」「〜できない」「〜のみ」など、実際には例外や幅があることを断定的・排他的に
            言い切っている。
          </li>
          <li>
            <span className="font-medium text-stone-900">⑥ 事例問題での「一見丁寧だが実践的には不適切」な対応</span>
            <br />
            善意や丁寧さは感じられるが、専門職の対応としては時期尚早な解釈の押し付けや、
            パターナリスティックな判断の先取りなど、実践上は適切でない選択肢。
          </li>
        </ol>
        <p className="mt-3 text-xs text-stone-400">
          このアプリが生成する問題も、これらの型を組み合わせて誤答を作るようにしていますが、
          1つの型だけに偏らないよう毎回複数の型を混ぜています。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">このアプリを使った進め方の目安</h2>
        <ul className="mt-2 space-y-2 text-sm leading-relaxed text-stone-700">
          <li className="flex gap-2">
            <span className="text-indigo-400">・</span>
            <span>
              苦手科目を後回しにしないこと。合格基準は「科目群ごと」なので、1科目でも手を抜くとその科目群
              まるごと落とすリスクになります。科目別演習で、成績ページの苦手科目TOP3から優先的に取り組むのがおすすめです。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-indigo-400">・</span>
            <span>
              60時間科目（社会福祉の原理と政策、社会保障、地域福祉と包括的支援体制、ソーシャルワークの理論と方法、
              精神医学と精神医療、現代の精神保健の課題と支援、精神保健福祉の原理、ソーシャルワークの理論と方法(専門)
              の8科目）は出題数も多く、養成課程でも重点科目とされています。優先的に演習量を確保してください。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-indigo-400">・</span>
            <span>
              全科目演習で、全18科目を1問ずつまんべんなく解くことができます。特定の科目に偏らず、
              抜けている分野が無いか定期的に確認する目的で使ってください。本番同様の出題数・時間制限で
              通しで力試しをしたい場合は実戦模試を使ってください。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-indigo-400">・</span>
            <span>
              間違えた問題は自動的に弱点ストックに入り、復習モードで間違えた回数が多いものほど優先的に
              再出題されます。ホーム画面の弱点ストック数を0に近づけることを、日々の目標にしてください。
            </span>
          </li>
        </ul>
      </section>

      <p className="text-xs text-stone-400">
        出典: 「第28回精神保健福祉士国家試験の合格基準及び正答について」／精神保健福祉士国家試験 出題基準・過去問（第27回・第28回）／
        厚生労働省「精神保健福祉士養成課程における教育内容」カリキュラム。合格基準の実際の点数は年度により変動します。
      </p>
    </div>
  );
}
