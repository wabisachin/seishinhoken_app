import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./llm";
import { supabase } from "./supabase";
import { retrieveForItem, RetrievedChunk, TaxonomyItem } from "./retrieval";
import { getLlmSettings } from "./appSettings";
import { logUsage } from "./usageLog";

/**
 * プロンプトキャッシング対策: 同じ項目に対する生成1〜2回目・検証呼び出しは
 * 「指示文＋根拠チャンク」の部分が完全に同一バイト列になるようにし、これを
 * 常に固定のtext partとして先頭に置く（可変部分は必ず後ろに続ける）。
 * OpenAI/Geminiは同一の先頭バイト列を自動でキャッシュするためこれだけで効く。
 * Anthropicは明示的なcache_controlが無いとキャッシュされないため、
 * 対応プロバイダでのみ有効なproviderOptionsとして付与しておく
 * （他プロバイダは未知のproviderOptionsを無視するだけなので安全）。
 */
function cachedPrefix(text: string) {
  return {
    type: "text" as const,
    text,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
  };
}

// LLMが稀にアラビア文字等、文字化けのような異言語文字を紛れ込ませることがあるため、
// 日本語・英語・数字・一般的な記号以外の文字が混入していないかをホワイトリスト方式で
// チェックする（許可する文字だけを列挙し、それ以外は問答無用で却下する）。
// ギリシャ文字(α遮断薬・β受容体等)は医学用語で正規に使われるため許可に含める
const ALLOWED_CHAR_RE = new RegExp(
  "[" +
    "\x09\x0A\x0D\x20-\x7E" + // タブ・改行・ASCII印字可能文字（英数字・半角記号）
    "\u00A0-\u00FF" + // Latin-1補助（アクセント文字・°±×÷µ等）
    "\u0370-\u03FF" + // ギリシャ文字
    "\u2013\u2014\u2018-\u201D\u2026" + // ダッシュ・引用符・三点リーダ
    "\u3000-\u303F" + // CJK記号と句読点
    "\u3040-\u309F" + // ひらがな
    "\u30A0-\u30FF" + // カタカナ
    "\u3400-\u4DBF" + // CJK統合漢字拡張A
    "\u4E00-\u9FFF" + // CJK統合漢字
    "\uFF00-\uFFEF" + // 半角・全角形
    "]",
)

function findForeignChars(text: string): string[] {
  const found = new Set<string>();
  for (const ch of text) {
    if (!ALLOWED_CHAR_RE.test(ch)) found.add(ch);
  }
  return [...found];
}

// 構造化出力スキーマ（プロバイダ非対応の制約は避け、後段で手動検証する）
// フィールド順序が生成順序に対応するため、必ず「各選択肢の正誤を吟味(explanations)」→
// 「その結論から正答を確定(correct)」の順にする。逆順だと正答を先に決め打ちしてから
// 解説を書くことになり、両者が矛盾する（＝検証で弾かれる）ケースが多発したため。
const questionSchema = z.object({
  question_type: z.enum(["single", "multi"]).describe("正答が1つならsingle、2つならmulti"),
  stem: z.string().describe("問題文。本番の国家試験の文体（〜として、適切なものを1つ選びなさい 等）"),
  case_text: z
    .string()
    .nullable()
    .describe(
      "事例問題の場合の事例文の本文のみ。冒頭に「〔事例〕」等のラベルを付けないこと" +
        "（画面表示側で自動的に付与されるため、含めると二重表示になる）。通常問題ならnull",
    ),
  options: z
    .array(z.string())
    .describe(
      "選択肢5つ。番号や記号は絶対に付けないこと（例:「1 ○○」「1. ○○」ではなく「○○」のみ）。" +
        "表示側で1〜5の番号を別途自動で付けるため、文字列側に番号を含めると番号が二重に表示される",
    ),
  explanations: z
    .array(z.string())
    .describe(
      "選択肢1〜5それぞれについて、根拠テキストに照らして正しいか誤りかを先に吟味して書く解説。" +
        "この時点でまだcorrectは決めず、ここでの吟味結果だけを根拠にする",
    ),
  correct: z
    .array(z.number().int())
    .describe("正答番号の配列（1始まり）。直前のexplanationsでの吟味結果と完全に一致させること。singleは1つ、multiは2つ"),
  key_points: z.string().describe("この問題で押さえるべき関連知識のまとめ。周辺概念・混同しやすい用語の整理を含む学習用メモ"),
  citation_chunk_ids: z.array(z.number().int()).describe("根拠として実際に使用したチャンクIDの配列（5つの選択肢の根拠の和集合）"),
  option_citations: z
    .array(
      z.array(
        z.object({
          chunk_id: z.number().int(),
          quote: z
            .string()
            .describe(
              "この選択肢のexplanationsを書く際に根拠にした、チャンク本文中の一節を後から" +
                "そのまま抜き出したもの（目安20〜60字）。あくまで既に確定した根拠チャンクの" +
                "中から引用元を指し示すだけの作業であり、stem/options/explanationsの書き方を" +
                "この抜き出しやすさのために変えてはならない（文体を根拠に寄せる、正答だけ" +
                "本文そのままにする等は禁止）。本文と完全一致しないと表示で強調されないだけで" +
                "問題自体は不正解にならないので、正確に抜き出せない場合は無理をせず空文字でよい",
            ),
        }),
      ),
    )
    .describe(
      "選択肢1〜5それぞれについて、その正誤判定(explanationsで書いた内容)の直接の根拠に使った" +
        "チャンクidと、その本文中の該当箇所の引用。要素数5でoptions/explanationsと同じ順序" +
        "（根拠にした具体的事実が無い選択肢は空配列でよい）。ここに登場するchunk_idは必ず" +
        "citation_chunk_idsにも含めること。『どの根拠のどの部分がどの選択肢の正誤を決めて" +
        "いるか』を利用者に示すために使う",
    ),
});

const verifySchema = z.object({
  ok: z.boolean().describe("すべての検証項目を満たすならtrue"),
  problems: z.array(z.string()).describe("問題点のリスト。okならば空配列"),
});

/**
 * LLMが指示に反して選択肢文字列の先頭に自分で番号を付けてしまうことがあり
 * （表示側でも1〜5の番号を付けるため「1 1 ○○」のように二重表示になる）、
 * その対策として自分の番号と一致する先頭の番号表記だけを取り除く。
 * 無関係な数字（例:「3年後に」）まで誤って削らないよう、その選択肢自身の
 * 番号と一致する場合だけ対象にする。
 */
function stripLeadingOptionNumber(text: string, index1based: number): string {
  const re = new RegExp(`^\\s*${index1based}\\s*[.．、,)\\]]?\\s*`, "u");
  const stripped = text.replace(re, "").trim();
  return stripped || text.trim();
}

function chunkBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) => `<chunk id="${c.id}" book="${c.book}" pages="${c.page_start}-${c.page_end}">\n${c.content}\n</chunk>`)
    .join("\n\n");
}

/**
 * 出題対象のタクソノミー項目を選ぶ。既存問題（active/rejected問わず）が
 * 最も少ない項目群からランダムに選ぶことで、200問に達するまでの間、
 * 特定の項目に偏らず出題基準全体をまんべんなくカバーする。
 * （最小件数以外を選ぶ余地を残すと、同じ項目の焼き直しが増えるリスクがあるため
 * 厳密な最小値限定にしている）
 */
async function pickTaxonomyItem(subject: string, profile: string): Promise<TaxonomyItem> {
  const sb = supabase();
  const { data: items, error } = await sb
    .from("taxonomy")
    .select("id, subject, major, middle, minor")
    .eq("subject", subject);
  if (error || !items || items.length === 0) {
    throw new Error(`taxonomy not found for subject=${subject}（extract_kijun.py 実行済みか確認）`);
  }
  // 本人・動作テスト用はそれぞれ独立したプールとして出題基準のカバレッジを判定する
  // （互いのプールを混ぜない。動作テスト用も本人と同じく200問に向けて満遍なく積み上げる）。
  const { data: existing } = await sb
    .from("questions")
    .select("taxonomy_id")
    .eq("subject", subject)
    .eq("profile", profile);
  const countByItem = new Map<number, number>();
  for (const row of existing ?? []) {
    if (row.taxonomy_id == null) continue;
    countByItem.set(row.taxonomy_id, (countByItem.get(row.taxonomy_id) ?? 0) + 1);
  }
  const withCounts = items.map((it) => ({ item: it as TaxonomyItem, count: countByItem.get(it.id) ?? 0 }));
  const minCount = Math.min(...withCounts.map((w) => w.count));
  const leastCovered = withCounts.filter((w) => w.count === minCount);
  return leastCovered[Math.floor(Math.random() * leastCovered.length)].item;
}

/** 同じ出題基準項目で既に作られた問題文と、根拠として使用済みの抜粋（重複回避の材料） */
async function existingCoverage(taxonomyId: number, profile: string, limit = 15) {
  // pickTaxonomyItemと同じ理由でprofileに限定する
  const { data } = await supabase()
    .from("questions")
    .select("stem, citations")
    .eq("taxonomy_id", taxonomyId)
    .eq("profile", profile)
    .order("id", { ascending: false })
    .limit(limit);
  const stems = (data ?? []).map((q) => q.stem as string);
  const excerpts = new Set<string>();
  for (const q of data ?? []) {
    for (const c of (q.citations as { excerpt?: string }[] | null) ?? []) {
      if (c.excerpt) excerpts.add(c.excerpt.slice(0, 150));
    }
  }
  return { stems, excerpts: [...excerpts] };
}

/**
 * 過去問(18科目・2回分264問を全件精査)を分析した結果の出題形式分類。
 * 当初は「知識説明(desc)／事例(case)／用語選択(term)」の3値enumとして実装していたが、
 * 事例文の有無で先に振り分けてしまうと、事例形式の中の用語選択（例: 場面を読んで
 * 該当する診断名・入院形態・自助グループ名を選ばせる）を判定する機会が失われ、
 * 実データの15.5%を占めるこの組み合わせが恒久的に生成不能になっていた
 * （264問全数の再精査で判明）。実際には次の2軸が独立しており、2×2で漏れなく分類できる:
 * - 枠組み軸 case/nocase: 「A精神保健福祉士」「Aさん」等の匿名の専門職・クライエントを
 *   主人公にした短い場面（case_text）があるかどうか
 * - 課題軸 term/desc: 選択肢が短い用語・固有名詞（病名・制度名・役職名・数値等）の
 *   羅列(term)か、完全な説明文(desc)か
 *
 * 264問中の実績比率（正答が判明している132問だけでなく全264問を対象、事例の有無・
 * 選択肢形状は正答表が無くても判定できるため）:
 *   nocase-desc 53.0% / nocase-term 15.9% / case-desc 15.5% / case-term 15.5%
 * この4分類で264問全てが過不足なく分類され、5つ目のカテゴリ（複数軸の組み合わせ問題等）
 * は実データに存在しなかった。
 *
 * term側の判定について: 「正しい用語はどれか」のようにstemが明示することは稀（264問中
 * 2問だけ）で、実際の大半は「〜として、正しいものを1つ選びなさい」という定型文のまま、
 * 選択肢が完全な説明文ではなく短い固有名詞・専門用語そのものになっている形。
 * まれに（264問中2問、医学概論に集中）「用語とその属性（時期・分類等）の組み合わせと
 * して正しいものを1つ選ぶ」ペア形式も見られたため、term系の指示にはこのバリエーションも
 * 含めている（サンプルが少なく単独の重み付きカテゴリにするほどの精度は無いため）。
 *
 * 科目によって各セルの出やすさに大きな差がある（例: 「ソーシャルワークの理論と方法」は
 * 事例形式が過去2回で18問中11問=61%、「精神医学と精神医療」は用語形式が79%を占める
 * 一方、他方はほぼ0%）ため、固定比率ではなく科目ごとの実績から動的に算出する
 * （下記computeFormatWeights）。
 */
export type CaseAxis = "case" | "nocase";
type TaskAxis = "desc" | "term";
type QFormat = `${CaseAxis}-${TaskAxis}`;

function classifyCaseAxis(caseText: string | null, combined: string): CaseAxis {
  return (caseText && caseText.trim().length > 0) || /[A-Za-zＡ-Ｚ]\s*さん/.test(combined) ? "case" : "nocase";
}

// 選択肢の過半数が文末記号（。/．、または「である/する/できる/となる」等の述語＋句点）で
// 終わっていなければ、文単位の説明文ではなく短い用語・固有名詞の羅列（用語選択形式）とみなす。
// 過去問264問の全数精査で、文字数の閾値（旧ロジック）は人物名・制度名・法律名などの長い
// 用語を「知識説明形式」に誤判定するケースが多く見つかった（例:「ウィンストン・チャーチル」
// のような人名の並び、長い法律用語の羅列は文字数だけなら20字を超えるが述語を伴わない）。
// 述語の有無という構造で判定する方が実態に近い。
function classifyTaskAxis(stem: string, options: string[]): TaskAxis {
  if (stem.includes("用語")) return "term";
  if (options.length === 0) return "desc";
  const sentenceLikeCount = options.filter((o) => /[。．]\s*$/.test(o.trim())).length;
  if (sentenceLikeCount / options.length < 0.5) return "term";
  return "desc";
}

function classifyFormat(stem: string, caseText: string | null, options: string[]): QFormat {
  const combined = `${stem} ${caseText ?? ""}`;
  return `${classifyCaseAxis(caseText, combined)}-${classifyTaskAxis(stem, options)}`;
}

const QFORMATS: QFormat[] = ["nocase-desc", "nocase-term", "case-desc", "case-term"];

/**
 * 科目ごとの出題形式の実績比率を算出する。その科目のサンプルが少ない/偏っている
 * 場合に引きずられすぎないよう、全科目平均を弱い事前分布として厚み K ぶんだけ
 * ベイズ的に混ぜる（科目のサンプルが多いほど、その科目自身の実績に近づく）。
 */
async function computeFormatWeights(subject: string): Promise<{ format: QFormat; weight: number }[]> {
  const { data } = await supabase().from("past_questions").select("subject, stem, case_text, options");
  const rows = data ?? [];
  const globalCounts: Record<QFormat, number> = { "nocase-desc": 0, "nocase-term": 0, "case-desc": 0, "case-term": 0 };
  const subjectCounts: Record<QFormat, number> = { "nocase-desc": 0, "nocase-term": 0, "case-desc": 0, "case-term": 0 };
  for (const r of rows) {
    const fmt = classifyFormat(r.stem as string, r.case_text as string | null, (r.options as string[]) ?? []);
    globalCounts[fmt]++;
    if (r.subject === subject) subjectCounts[fmt]++;
  }
  const globalTotal = Math.max(1, QFORMATS.reduce((sum, f) => sum + globalCounts[f], 0));
  const subjectTotal = QFORMATS.reduce((sum, f) => sum + subjectCounts[f], 0);
  // 平滑化の強さ（このぶんだけ全体平均寄りに引っ張る）。科目ごとのサンプルは
  // 過去問2回分で1科目あたり平均15問程度しか無く、そのまま実績比率にすると
  // 少数サンプルのブレ（たまたま0問だった等）をそのまま信じてしまう。そのため
  // K=15と、平均的な科目サンプル数と同程度まで強めにして、科目差自体は残しつつ
  // （精神医学と精神医療のterm多用等、実際に大きな差がある科目はK=15でも
  // 十分残る）全体傾向寄りに引っ張る比重を上げている。
  const K = 15;
  return QFORMATS.map((format) => {
    const globalP = globalCounts[format] / globalTotal;
    const weight = (subjectCounts[format] + globalP * K) / (subjectTotal + K);
    return { format, weight };
  });
}

// forceCaseAxis用: 4分類のうち片方の枠組み軸だけに絞った後、残った2分類の重みを
// 合計1になるよう正規化する（絞り込み後も確率抽選として成立させるため）。
function normalizeWeights(weights: { format: QFormat; weight: number }[]): { format: QFormat; weight: number }[] {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return weights.map((w) => ({ ...w, weight: 1 / Math.max(1, weights.length) }));
  return weights.map((w) => ({ ...w, weight: w.weight / total }));
}

function pickFormat(weights: { format: QFormat; weight: number }[]): QFormat {
  const r = Math.random();
  let acc = 0;
  for (const { format, weight } of weights) {
    acc += weight;
    if (r < acc) return format;
  }
  // 浮動小数点誤差で合計が1未満になった場合のみここに来る。forceCaseAxisで絞り込まれた
  // weightsを渡された時に固定値へフォールバックすると軸が壊れるため、渡された最後の
  // エントリを使う（weightsが空になることは無い呼び出し方しかしていない）。
  return weights[weights.length - 1]?.format ?? "nocase-desc";
}

/**
 * 正答数(1つ/2つ)も出題形式と同じ問題を抱えていた ―― 過去問全体では約24%が
 * 五肢択二（correct 2つ）なのに、明示的に指示しないとLLMはほぼ常に1つに
 * してしまう。科目によって割合の差も大きい（0%〜67%）ため、出題形式と
 * 同じくベイズ平滑化した科目ごとの実績比率で1問ごとに確定的に抽選する。
 */
async function computeAnswerCountWeights(subject: string): Promise<{ count: 1 | 2; weight: number }[]> {
  const { data } = await supabase().from("past_questions").select("subject, correct");
  const rows = (data ?? []).filter((r) => Array.isArray(r.correct) && r.correct.length > 0);
  const globalCounts: Record<1 | 2, number> = { 1: 0, 2: 0 };
  const subjectCounts: Record<1 | 2, number> = { 1: 0, 2: 0 };
  for (const r of rows) {
    const n = (r.correct as number[]).length === 2 ? 2 : 1;
    globalCounts[n]++;
    if (r.subject === subject) subjectCounts[n]++;
  }
  const globalTotal = Math.max(1, globalCounts[1] + globalCounts[2]);
  const subjectTotal = subjectCounts[1] + subjectCounts[2];
  // computeFormatWeightsと同じ理由（科目あたり平均15問程度の少数サンプル）でKを強めにする
  const K = 15;
  return ([1, 2] as const).map((count) => {
    const globalP = globalCounts[count] / globalTotal;
    const weight = (subjectCounts[count] + globalP * K) / (subjectTotal + K);
    return { count, weight };
  });
}

function pickAnswerCount(weights: { count: 1 | 2; weight: number }[]): 1 | 2 {
  const r = Math.random();
  let acc = 0;
  for (const { count, weight } of weights) {
    acc += weight;
    if (r < acc) return count;
  }
  return 1;
}

const CASE_FRAMING_INSTRUCTION =
  "「A精神保健福祉士」「Aさん」のように匿名の専門職またはクライエントを主人公にした短い場面を"
  + "case_textに書くこと。場面設定は根拠テキストの範囲で無理なく成立させ、根拠テキストに無い事実は使わない。";

const FORMAT_INSTRUCTION: Record<QFormat, string> = {
  "nocase-desc": "知識説明形式で作成すること。対象の事象・概念・制度・理論等について、正しい/誤った説明を選ばせる（case_textはnullでよい）。",
  "case-desc": "事例形式で作成すること。" + CASE_FRAMING_INSTRUCTION
    + "その場面における適切な認識・対応・該当する概念などをstemで問い、選択肢は完全な説明文にする"
    + "（例:「次のうち、Aさんの状態として、最も適切なものを1つ選びなさい」の選択肢に、対応や状態の説明文を並べる）。",
  "nocase-term": "用語・名称選択形式で作成すること。選択肢を完全な説明文にせず、短い用語・固有名詞（病名・制度名・"
    + "役職名・分類名・数値等）そのものにする。stemは「正しい用語はどれか」と明示する必要は無く、"
    + "「次のうち、〜として、正しいものを1つ選びなさい」のような通常の定型文でよい（case_textはnullでよい）。"
    + "まれに、用語とその属性（時期・分類・段階等）の組み合わせを1行ずつ選択肢に並べ、正しい組み合わせの行を"
    + "1つ選ばせる形式にしてもよい（例: 発達段階とその時期のペアを5パターン並べ、正しいペアの行を選ばせる）。",
  "case-term": "事例形式かつ用語・名称選択形式で作成すること。" + CASE_FRAMING_INSTRUCTION
    + "選択肢は完全な説明文にせず、その場面に該当する短い用語・固有名詞（診断名・入院形態・制度名・"
    + "自助グループ名・職種名等）そのものにする（例:「次のうち、Aさんが利用した入院形態として、"
    + "最も適切なものを1つ選びなさい」の選択肢に、措置入院・医療保護入院等の制度名だけを並べる）。",
};

/**
 * 今回作成する問題と同じ出題形式(targetFormat)の実際の過去問を最大n件、few-shotとして
 * 提示する。同じ科目にn件揃っていれば同じ科目だけで埋め、足りない分だけ他科目から
 * 同じ形式の実例をランダムに補う（他科目からの補充を毎回同じ問題に偏らせず、多様な
 * 問題生成をLLMに促すため）。形式が一致しない実例で頭数を揃えることはしない
 * （出題形式の手本としての正確さより件数を優先すると、かえって狙った形式から
 * 外れやすくなるため）。
 */
async function fewShotExamples(subject: string, targetFormat: QFormat, n = 5): Promise<string> {
  // correctが空の過去問（正答表が無い年度分）は「正答: 」が空欄になり手本として
  // 不完全なので、few-shotの材料からは除外する
  const hasAnswer = (q: { correct: unknown }) => Array.isArray(q.correct) && q.correct.length > 0;
  const classify = (q: { stem: unknown; case_text: unknown; options: unknown }) =>
    classifyFormat(q.stem as string, q.case_text as string | null, (q.options as string[]) ?? []);

  const { data: subjectRows } = await supabase()
    .from("past_questions")
    .select("stem, case_text, options, correct")
    .eq("subject", subject)
    .limit(40);
  const sameSubjectMatches = (subjectRows ?? [])
    .filter(hasAnswer)
    .filter((q) => classify(q) === targetFormat)
    .sort(() => Math.random() - 0.5);

  let picks = sameSubjectMatches.slice(0, n);

  if (picks.length < n) {
    const { data: globalRows } = await supabase()
      .from("past_questions")
      .select("stem, case_text, options, correct")
      .neq("subject", subject)
      .limit(600);
    const otherSubjectMatches = (globalRows ?? [])
      .filter(hasAnswer)
      .filter((q) => classify(q) === targetFormat)
      .sort(() => Math.random() - 0.5);
    picks = [...picks, ...otherSubjectMatches.slice(0, n - picks.length)];
  }

  if (picks.length === 0) {
    return "（この出題形式に一致する過去問例が見つかりませんでした。上記の出題形式の指示に厳密に従うこと）";
  }

  return picks
    .map((q, i) => {
      const opts = (q.options as string[]).map((o, j) => `${j + 1} ${o}`).join("\n");
      // ラベルは「〔事例〕」ではなく別の記法にする（case_textスキーマの指示通りLLMが
      // 「〔事例〕」を付けずに書けているかの手本を汚さないため。過去問データ自体には
      // ラベルは含まれておらず、ここで一時的な表示用に付与しているだけ）
      const caseText = q.case_text ? `（事例文）\n${q.case_text}\n\n` : "";
      return `【実際の過去問 例${i + 1}】\n${caseText}${q.stem}\n${opts}\n正答: ${(q.correct as number[]).join(", ")}`;
    })
    .join("\n\n");
}

export type GenerateResult = {
  questionId: number | null;
  status: "active" | "rejected";
  subject: string;
  topic: string;
  problems?: string[];
};

/**
 * 指定科目からタクソノミー項目を1つ選んで問題を1問生成・検証・保存する。
 * 使用するLLMはapp_settings（管理者のみ変更可）で決まる。クライアントから
 * 指定させる経路は無い ── これを崩すと「ユーザーが勝手にモデルを変更できる」
 * ことになり、管理者専用にする要件そのものが破られるため、ここに引数を
 * 増やして呼び出し元から渡させるようなことは絶対にしないこと。
 *
 * profile（"self"|"test"）は必須引数。本人・動作テスト用それぞれ独立したプールに
 * 生成・保存する（questions.profile列で分離。他のattempts等と同じくクライアント自己申告の
 * 区分をそのまま使う。LLMモデル選択とは別軸の関心事なので上記の制約には抵触しない）。
 *
 * pool・forceCaseAxisはサーバー内部のストック補充ロジックだけが渡す値で、クライアントから
 * 到達できない。poolに'exam'を指定すると実戦模試専用の未消費ストックとして書き込まれ、
 * 通常の科目別演習・全科目演習の出題プールからは見えなくなる
 * （questionSupply.ts側でpool='general'にフィルタしているため）。
 * forceCaseAxisを指定すると、出題形式抽選のうち枠組み軸（事例の有無）だけを固定し、
 * 課題軸（用語選択/知識説明）はその軸内で科目ごとの実績比率から通常通り抽選する
 * （科目別演習の「事例問題のみ／事例なし」フィルタ用ストックを狙って埋めるための機能）。
 */
export async function generateOneQuestion(
  subject: string,
  profile: string,
  opts: { pool?: "general" | "exam"; forceCaseAxis?: CaseAxis } = {},
): Promise<GenerateResult> {
  const pool = opts.pool ?? "general";
  const sb = supabase();
  const llm = await getLlmSettings();

  // 1. 出題対象のタクソノミー項目を選択（既存問題が少ない項目を優先）
  const item = await pickTaxonomyItem(subject, profile);
  const topic = [item.major, item.middle, item.minor].filter(Boolean).join(" > ");

  // 2. HyDE検索で根拠チャンク+周辺チャンクを取得
  const { main, neighbor } = await retrieveForItem(item, llm);
  if (main.length === 0) throw new Error("チャンク検索結果が空です（埋め込み投入済みか確認）");

  // 3. 出題形式・正答数を科目ごとの実績比率から抽選（知識説明/事例/用語選択、五肢択一/択二）
  //    ＋few-shot（同科目の実際の過去問）＋この項目で既出の問題・根拠抜粋（重複回避用）
  const formatWeights = await computeFormatWeights(subject);
  const scopedFormatWeights = opts.forceCaseAxis
    ? normalizeWeights(formatWeights.filter((w) => w.format.startsWith(`${opts.forceCaseAxis}-`)))
    : formatWeights;
  const format = pickFormat(scopedFormatWeights);
  const answerCountWeights = await computeAnswerCountWeights(subject);
  const answerCount = pickAnswerCount(answerCountWeights);
  const fewShot = await fewShotExamples(subject, format);
  const { stems: pastStems, excerpts: pastExcerpts } = await existingCoverage(item.id, profile);

  // キャッシュを2段に分ける。
  // (1) universalInstructions: 科目・項目に一切依存しない、文字通り全呼び出し共通の
  //     指示文。科目をまたいでも同一バイト列になるため、topUpAllSubjects/Cronのように
  //     短時間に大量の生成が走る場面ではこのブロックだけでも複数科目間でキャッシュが効く
  //     （OpenAI/Geminiの自動プレフィックスキャッシュはブロック単位でなく生の先頭バイト列で
  //     一致判定するため、この後段に可変部分が続いても問題ない）。
  // (2) itemContext: 科目・項目・根拠チャンクに依存するが、同一項目に対する生成1〜2回目
  //     （リトライ）の間では完全に同一バイト列になる部分。Anthropicは明示的なcache_control
  //     が無いとキャッシュされず、かつブロック単位でキャッシュ境界を打つ必要があるため、
  //     両方に別々にcache_controlを付けて、科目非依存の(1)と同一項目内の(2)それぞれで
  //     キャッシュヒットの機会を最大化する。
  const universalInstructions = `あなたは精神保健福祉士国家試験の作問委員です。教科書の記述のみを根拠に、本番と同水準の問題を1問作成してください。

# 作問ルール
- 【最重要・自己完結性】受験者が実際に画面上で目にできるのは、あなたが書くstem（問題文）・
  case_text（事例文、あれば）・options（選択肢）の3つだけである。あなたが今読んでいる根拠テキスト
  そのものは受験者には一切見えない。したがって、stemやoptionsの中で「本文」「上記の文章」
  「上記の資料」「次の文章を読んで」「下線部」「別紙」「設問1の内容を踏まえて」のように、
  受験者が読める形で実際には提示されていない何かを参照する書き方を絶対にしてはならない。
  これは表記の一例に過ぎず、禁止したい本質は表記そのものではなく、「stem・case_text・
  optionsの3つの中に書かれている情報だけでは、原理的に正誤を判断できない・意味が
  通らない問題になっていないか」である。事例文の内容に基づかせたい場合は、その事例の
  内容をcase_textとして実際に書き、stemでは「Aさんの状況として」のように、いま画面に
  表示されているcase_textを指す普通の言い方をすること。教科書の記述を根拠にする場合も、
  「教科書によれば」ではなく、その知識を問題文・選択肢自体に溶け込ませて自己完結させること
- 問題形式は五肢択一（correct 1つ）と五肢択二（correct 2つ、問題文に「2つ選びなさい」と明記）の
  2種類があるが、今回どちらにするかは下の「今回作成する問題の正答数」で指定するので必ずそれに従うこと
  （指定を無視して常に1つにすると、実際の過去問の約24%を占める択二形式を再現できない）
- 正答は根拠テキストの記述から明確に導けること。根拠テキストに無い事実を使わない
- 選択肢の作り方（最重要。過去問132問（正答が判明している設問）の全数精査に基づく。実際の
  過去問では5つの選択肢の文の長さ・具体性・専門用語密度・言い切り方がほぼ揃っており、
  「文体だけで見分けられる選択肢」はほぼ存在しない。正誤の判別には必ずその分野の具体的な
  事実知識が要る。誤答は「読めば違和感がある」ものであってはならず、「知らなければ正しく
  見える」ものでなければならない）:
  - register parity（文体の対称性）を必ず守ること。正誤に関わらず5つの選択肢すべてを同じ
    自信度・具体性・専門用語密度で書くこと:
    - 正答だけを、反証されにくい余白や含みを残した安全な言い回し（「〜な場合もある」
      「〜と考えられている」等のヘッジ表現）に逃がすのは禁止。正答も誤答と同じくらい
      踏み込んだ、具体的で言い切った記述にすること。「一番歯切れが悪い/曖昧な選択肢が
      正答」という当てずっぽうの必勝法が成立してはならない
    - 逆に誤答だけを「常に」「一切」「〜ではない」のような極端な断定語で不自然に強めて
      「いかにも怪しい」見た目にするのも禁止。根拠テキストが実際にそう書いている場合を
      除き、断定的な語句を選択肢の正誤を目立たせる目的だけで追加・削除しないこと
      （実際の過去問でもこの種の語句の登場頻度に正答・誤答間の有意な偏りは無い）
  - 誤答は必ず、根拠テキストまたは一般知識に基づく実在の別の事実に差し替えて作ること
    （4つの誤答にそれぞれ異なる差し替え方を使い、1つの型だけに偏らないこと）:
    a. 概念・用語・理論のすり替え（最頻出）: 同じ分野の別の概念・分類・理論の定義を、
       問われている対象の定義であるかのように提示する
    b. 人物と業績の取り違え: 実在の人物名は正しいが、別の人物の理論・功績・立場を割り当てる
    c. 制度・法律の主体・対象・要件・数値のすり替え: 実施主体・対象範囲・要件・年齢・年数・
       比率・年号などを、実際とは異なる別の実在の値・対象に置き換える
    d. 事例・場面問題では、別の技法・別のアプローチとして見れば正しい対応を、問われている
       技法・アプローチの対応であるかのように提示する（応答内容自体は専門職としてもっとも
       らしく、その技法特有のポイントだけがずれている）
    根拠チャンクには「周辺トピックのテキスト」として、本体と意味的に近い別項目の実際の
    教科書記述も渡されている。これは無関係な話ではなく、本体の次に近い実在の概念・制度・
    人物なので、誤答を当てずっぽうで作文する代わりに、この周辺トピックの実際の記述を
    差し替え材料として最優先で使うこと（存在しない概念のでっち上げは、知識が無くても
    「聞いたことがないから違う」と分かってしまい問題として成立しない）
  - 明らかに的外れな選択肢は禁止。受験者が迷う「近いが違う」ものにする
  - 各選択肢は「なぜ正しいか／なぜ誤りか」を根拠テキストまたは一般に確立した知識で
    具体的に説明できること（正答・誤答のどちらであっても「特に理由は無いがそれっぽい」
    選択肢は禁止）
- 手順は必ずこの順で行うこと（正答を先に決めてから理由を後付けしない）:
  1. まずexplanationsで選択肢1〜5それぞれを根拠テキストと照合し、正しいか誤りかを個別に吟味して書く
  2. その吟味結果だけを根拠にcorrectを決める（explanationsの結論とcorrectが食い違うことは絶対に許されない）
- explanations は選択肢1〜5の順に5つ。学習に役立つよう具体的に書く
- key_points はこの問題の周辺で覚えるべきことの整理（混同しやすい概念の対比など）
- citation_chunk_ids には実際に根拠として使ったチャンクのid（整数）を入れる
- option_citations は選択肢1〜5それぞれについて、その正誤判定に直接使ったチャンクidと、その
  本文中の該当箇所の引用(quote)を対応する位置に入れる。「どの根拠のどの部分がどの選択肢の
  正誤を決めたか」を受験者に示すために使うので、根拠が特定できる限りできるだけ具体的に
  対応付けること。誤答であっても、根拠テキストの別の記述と矛盾する形で作った場合はその
  根拠チャンクを入れる（誤答の根拠が一般知識のみで該当チャンクが無い場合のみ空配列でよい）。
  これはstem/options/explanationsを全て書き終えた後に行う後付けの引用作業であり、逆に
  この引用のしやすさのためにstem/options/explanationsの書き方・言い回しを変えてはならない
  （根拠テキストに文体を寄せる、正答だけ本文そのままにする等は「文体を操作しないこと」の
  ルールに反するため厳禁）。quoteが本文と正確に一致しない場合は表示で強調されないだけで
  問題自体が不正解になるわけではないので、無理に一致させようとせず空文字でも構わない

# 出題形式（過去問18科目・2回分264問の全数分析に基づく2軸4分類。「事例文の有無」と
# 「選択肢が用語か説明文か」は独立した軸であり、両方を掛け合わせて考える必要がある。
# 全体の目安比率は 知識説明(nocase-desc)53%・用語選択(nocase-term)16%・
# 事例×説明文(case-desc)16%・事例×用語選択(case-term)16%。科目によって各分類の
# 出やすさにはかなり差がある。今回どの分類で作るかは下の「今回作成する問題の出題形式」で
# 指定するので、必ずそれに従うこと。指定を無視すると知識説明形式ばかりに偏ってしまうため）
- 知識説明形式: ${FORMAT_INSTRUCTION["nocase-desc"]}
- 用語選択形式: ${FORMAT_INSTRUCTION["nocase-term"]}
- 事例形式（選択肢が説明文）: ${FORMAT_INSTRUCTION["case-desc"]}
- 事例形式（選択肢が用語選択）: ${FORMAT_INSTRUCTION["case-term"]}`;

  const itemContext = `# 出題対象
科目: ${subject}
出題基準の項目: ${topic}

# 根拠テキスト（教科書からの抜粋。この内容のみを事実の根拠とすること）
${chunkBlock(main)}

# 周辺トピックのテキスト（誤答選択肢の材料に使ってよい）
${chunkBlock(neighbor)}`;

  const variableSuffix = `# 今回作成する問題の出題形式
${FORMAT_INSTRUCTION[format]}

# 今回作成する問題の正答数
${
  answerCount === 2
    ? "五肢択二で作成すること。question_typeは\"multi\"、correctは2つ、問題文の末尾に「2つ選びなさい」と明記する。"
    : "五肢択一で作成すること。question_typeは\"single\"、correctは1つ。"
}

# 実際の過去問の文体・形式（これに厳密に合わせる）
${fewShot}

# この項目で既に出題済みの問題文（重複厳禁。同じ論点の焼き直しをせず、根拠テキストの別の側面・別の記述を使うこと）
${pastStems.length ? pastStems.map((s, i) => `${i + 1}. ${s}`).join("\n") : "（まだ無し）"}

# 既に根拠として使用済みの抜粋（できるだけ避け、根拠テキストの別の部分を使うこと）
${pastExcerpts.length ? pastExcerpts.map((e, i) => `${i + 1}. ${e}...`).join("\n") : "（まだ無し）"}`;

  const model = getModel(llm);
  const modelName = llm.model;

  let lastProblems: string[] = [];
  let lastQ: z.infer<typeof questionSchema> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = lastProblems.length
      ? `\n\n# 前回生成の問題点（必ず修正すること）\n- ${lastProblems.join("\n- ")}`
      : "";
    const { object: q, usage: generateUsage } = await generateObject({
      model,
      schema: questionSchema,
      // OpenAIのプロンプトキャッシュはリクエストを同じバックエンドに寄せる
      // ルーティングに依存するため、prompt_cache_keyを固定しないと同一の
      // 先頭バイト列でもヒットしない（他プロバイダは未知のproviderOptionsを無視するだけ）
      providerOptions: { openai: { promptCacheKey: "quiz-generate-v1" } },
      prompt: [
        {
          role: "user",
          content: [
            cachedPrefix(universalInstructions),
            cachedPrefix(itemContext),
            { type: "text", text: variableSuffix + retryNote },
          ],
        },
      ],
    });
    await logUsage({ source: "generate", subject, provider: llm.provider, model: modelName, usage: generateUsage });
    q.options = q.options.map((o, i) => stripLeadingOptionNumber(o, i + 1));
    lastQ = q;

    // 形式チェック
    const formatProblems: string[] = [];
    if (q.options.length !== 5) formatProblems.push("選択肢が5つでない");
    if (q.explanations.length !== 5) formatProblems.push("解説が5つでない");
    if (q.option_citations.length !== 5) formatProblems.push("選択肢ごとの根拠が5つでない");
    if (q.correct.length < 1 || q.correct.length > 2) formatProblems.push("正答数が1〜2でない");
    if (q.correct.some((c) => c < 1 || c > 5)) formatProblems.push("正答番号が1〜5の範囲外");
    if ((q.question_type === "single") !== (q.correct.length === 1)) formatProblems.push("question_typeと正答数が不一致");
    if (q.correct.length > 0 && q.correct.length <= 2 && q.correct.length !== answerCount) {
      formatProblems.push(`指定した正答数(${answerCount}つ)に従っていない`);
    }
    const foreignChars = [
      ...new Set(
        [q.stem, q.case_text ?? "", q.key_points, ...q.options, ...q.explanations].flatMap((t) => findForeignChars(t)),
      ),
    ];
    if (foreignChars.length > 0) {
      formatProblems.push(`日本語・英語・数字・一般的な記号以外の文字が混入している: ${foreignChars.join(" ")}`);
    }
    if (formatProblems.length > 0) {
      lastProblems = formatProblems;
      continue;
    }

    // 4. 検証パス: 根拠テキストと照合
    // ここも生成パスと同様に、科目・項目非依存の指示文と、根拠チャンク（同一項目の
    // 検証呼び出し間で不変）を別ブロックに分けてキャッシュの機会を最大化する。
    const optionsList = q.options.map((o, i) => `${i + 1} ${o}`).join("\n");
    const verifyInstructions = `あなたは試験問題の校閲者です。次の問題を根拠テキストと照合し、以下をすべて検証してください:
1. 正答が根拠テキストの記述で支持されること
2. 各誤答選択肢が根拠テキストと矛盾する、または明確に誤りであること（正答になり得る誤答が無いこと）
3. 問題文・選択肢に根拠テキストに無い事実の捏造が無いこと
4. 五肢択一/択二として成立していること（正答が一意に定まる）
5. 内容の知識が完全に無い人でも、文体の違い（誤答だけ妙に断定的・極端・曖昧、正答だけ自然、など）
   だけを手がかりに正答に自信を持って辿り着けてしまう場合**のみ**、ここで指摘してok=falseとすること。
   判断基準は「その文体の違いだけで、内容を一切知らない人でも正答を確信できるか」であり、
   多少の言い回し・具体性の揺らぎは自然な範囲として許容し、そのレベルでは指摘しないこと
   （1〜4を満たしている限り、5だけを理由に却下し続けると、内容的には正しい問題が
   大量に無駄になる。5は「際立って露骨な場合」だけの最終防波堤として使うこと）
6. 自己完結性: 受験者が実際に画面で見るのはstem・case_text・options（下記「問題」欄そのもの）
   だけであり、この根拠テキストは見えない。stemやoptionsが「本文」「上記の文章」「上記の資料」
   「下線部」「別紙」のように、実際には受験者に提示されていない何かの存在を前提にしていて、
   その情報が無いと原理的に正誤を判断できない・意味が通らない問題になっている場合はok=falseとし、
   具体的にどの記述が何を前提にしてしまっているかをproblemsに書くこと`;
    const verifyItemContext = `# 根拠テキスト
${chunkBlock(main)}
${chunkBlock(neighbor)}`;
    const verifyTarget = `# 問題
${q.case_text ? `〔事例〕${q.case_text}\n` : ""}${q.stem}
${optionsList}
正答: ${q.correct.join(", ")}`;
    const { object: verdict, usage: verifyUsage } = await generateObject({
      model,
      schema: verifySchema,
      providerOptions: { openai: { promptCacheKey: "quiz-verify-v1" } },
      prompt: [
        {
          role: "user",
          content: [
            cachedPrefix(verifyInstructions),
            cachedPrefix(verifyItemContext),
            { type: "text", text: verifyTarget },
          ],
        },
      ],
    });
    await logUsage({ source: "verify", subject, provider: llm.provider, model: modelName, usage: verifyUsage });

    // option_citations（選択肢ごとの根拠チャンク＋該当箇所の引用）とcitation_chunk_ids（全体の
    // 和集合）の和集合を実際に引用として残す。LLMがcitation_chunk_idsへの転記を忘れても、
    // 選択肢側に挙げたidがあれば引用として表示できるようにするための冗長化
    const optionChunkIds = q.option_citations.map((entries) => entries.map((e) => e.chunk_id));
    const citedIds = new Set([...q.citation_chunk_ids, ...optionChunkIds.flat()]);
    const allChunks = [...main, ...neighbor];
    const citations = allChunks
      .filter((c) => citedIds.has(c.id))
      .map((c) => {
        const quotes = q.option_citations.flatMap((entries, idx) =>
          entries.filter((e) => e.chunk_id === c.id).map((e) => ({ option: idx + 1, quote: e.quote })),
        );
        return {
          chunk_id: c.id,
          book: c.book,
          page_start: c.page_start,
          page_end: c.page_end,
          excerpt: c.content,
          supports: quotes.map((qq) => qq.option),
          quotes,
        };
      });
    // 引用が空なら上位チャンクを引用として付ける
    if (citations.length === 0 && main.length > 0) {
      citations.push({
        chunk_id: main[0].id,
        book: main[0].book,
        page_start: main[0].page_start,
        page_end: main[0].page_end,
        excerpt: main[0].content,
        supports: [],
        quotes: [],
      });
    }

    const status = verdict.ok ? "active" : attempt === 1 ? "rejected" : null;
    if (status === null) {
      lastProblems = verdict.problems;
      continue;
    }

    const { data: inserted, error } = await sb
      .from("questions")
      .insert({
        subject,
        taxonomy_id: item.id,
        question_type: q.question_type,
        stem: q.stem,
        case_text: q.case_text,
        options: q.options,
        correct: q.correct,
        explanations: q.explanations,
        key_points: q.key_points,
        citations,
        status,
        model: modelName,
        pool,
        profile,
      })
      .select("id")
      .single();
    if (error) throw new Error(`insert failed: ${error.message}`);

    return {
      questionId: inserted.id,
      status,
      subject,
      topic,
      problems: verdict.ok ? undefined : verdict.problems,
    };
  }

  // ここに来るのは、2回とも形式チェック（formatProblems）で弾かれた場合のみ
  // （検証(verify)まで進んだ場合は、良し悪しに関わらず必ず上のループ内でinsertされて
  // returnする）。この経路でDBに何も書かずに終わると、HARD_CAP_TOTAL/SUBJECT_TARGETの
  // 安全弁（DBの行数を直接数える方式）がこの失敗を一切観測できず、こちら側の形式
  // チェックに万一バグがあった場合に「却下され続けるが上限判定は動かない」という
  // 致命的な抜け道になる。そのため、たとえ形式が崩れていても却下として必ず1行残す。
  if (lastQ) {
    await sb.from("questions").insert({
      subject,
      taxonomy_id: item.id,
      question_type: lastQ.question_type,
      stem: lastQ.stem,
      case_text: lastQ.case_text,
      options: lastQ.options,
      correct: lastQ.correct,
      explanations: lastQ.explanations,
      key_points: lastQ.key_points,
      citations: null,
      status: "rejected",
      model: modelName,
      pool,
      profile,
    });
  }

  return { questionId: null, status: "rejected", subject, topic, problems: lastProblems };
}
