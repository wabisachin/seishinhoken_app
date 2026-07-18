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

// 構造化出力スキーマ（プロバイダ非対応の制約は避け、後段で手動検証する）
// フィールド順序が生成順序に対応するため、必ず「各選択肢の正誤を吟味(explanations)」→
// 「その結論から正答を確定(correct)」の順にする。逆順だと正答を先に決め打ちしてから
// 解説を書くことになり、両者が矛盾する（＝検証で弾かれる）ケースが多発したため。
const questionSchema = z.object({
  question_type: z.enum(["single", "multi"]).describe("正答が1つならsingle、2つならmulti"),
  stem: z.string().describe("問題文。本番の国家試験の文体（〜として、適切なものを1つ選びなさい 等）"),
  case_text: z.string().nullable().describe("事例問題の場合の事例文。通常問題ならnull"),
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
  citation_chunk_ids: z.array(z.number().int()).describe("根拠として実際に使用したチャンクIDの配列"),
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
async function pickTaxonomyItem(subject: string): Promise<TaxonomyItem> {
  const sb = supabase();
  const { data: items, error } = await sb
    .from("taxonomy")
    .select("id, subject, major, middle, minor")
    .eq("subject", subject);
  if (error || !items || items.length === 0) {
    throw new Error(`taxonomy not found for subject=${subject}（extract_kijun.py 実行済みか確認）`);
  }
  const { data: existing } = await sb.from("questions").select("taxonomy_id").eq("subject", subject);
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
async function existingCoverage(taxonomyId: number, limit = 15) {
  const { data } = await supabase()
    .from("questions")
    .select("stem, citations")
    .eq("taxonomy_id", taxonomyId)
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
 * 過去問(18科目・2回分264問を全件精査)を分析した結果の出題形式3分類。
 * - desc: 事象・概念・制度・理論等を、文単位の説明文の正誤で問う知識説明形式
 * - case: 「A精神保健福祉士」「Aさん」等の匿名の専門職・クライエントを主人公にした
 *   短い場面を設定し、その場面における適切な認識・対応等を問う事例形式（全体では
 *   約24%を占めるにもかかわらず、放置するとLLMがほぼ生成しない形式）
 * - term: 用語・名称そのものを選ばせる形式。「正しい用語はどれか」のようにstemが
 *   明示することは稀（264問中2問だけ）で、実際の大半は「〜として、正しいものを
 *   1つ選びなさい」という定型文のまま、選択肢が完全な説明文ではなく短い固有名詞・
 *   専門用語（病名・制度名・役職名・数値等）そのものになっている形。stemの文字列
 *   一致だけで判定すると1%未満に見えるが、選択肢の平均文字数まで見ると実際には
 *   全体の約18%を占める（医学概論・精神医学と精神医療等の科目に偏って多く、
 *   社会学と社会システム・社会保障等の政策・対人援助系科目にはほぼ出ない）。
 *   まれに（264問中2問、医学概論に集中）「用語とその属性（時期・分類等）の
 *   組み合わせとして正しいものを1つ選ぶ」ペア形式も見られたため、term形式の
 *   指示（FORMAT_INSTRUCTION.term）にはこのバリエーションも含めている
 *   （サンプルが少なく単独の重み付きカテゴリにするほどの精度は無いため）。
 *
 * 科目によってcase・termの出やすさに大きな差がある（例: 「ソーシャルワークの理論と
 * 方法」は事例形式が過去2回で18問中11問=61%、「精神医学と精神医療」は用語形式が
 * 79%を占める一方、他方はほぼ0%）ため、固定比率ではなく科目ごとの実績から動的に
 * 算出する（下記computeFormatWeights）。
 */
type QFormat = "case" | "term" | "desc";

// 選択肢の平均文字数がこれ未満なら、文単位の説明文ではなく短い用語・固有名詞の
// 羅列（用語選択形式）とみなす（過去問精査で「用語」を明示するstemはほぼ無い一方、
// 選択肢自体は短い名称のみというケースが大半だったため、実質的な判定材料はこちら）。
const TERM_AVG_OPTION_LENGTH = 20;

function classifyFormat(stem: string, caseText: string | null, options: string[]): QFormat {
  const combined = `${stem} ${caseText ?? ""}`;
  if ((caseText && caseText.trim().length > 0) || /[A-Za-zＡ-Ｚ]\s*さん/.test(combined)) return "case";
  if (stem.includes("用語")) return "term";
  const avgOptionLength = options.length > 0 ? options.reduce((sum, o) => sum + o.length, 0) / options.length : Infinity;
  if (avgOptionLength < TERM_AVG_OPTION_LENGTH) return "term";
  return "desc";
}

const QFORMATS: QFormat[] = ["desc", "case", "term"];

/**
 * 科目ごとの出題形式の実績比率を算出する。その科目のサンプルが少ない/偏っている
 * 場合に引きずられすぎないよう、全科目平均を弱い事前分布として厚み K ぶんだけ
 * ベイズ的に混ぜる（科目のサンプルが多いほど、その科目自身の実績に近づく）。
 */
async function computeFormatWeights(subject: string): Promise<{ format: QFormat; weight: number }[]> {
  const { data } = await supabase().from("past_questions").select("subject, stem, case_text, options");
  const rows = data ?? [];
  const globalCounts: Record<QFormat, number> = { desc: 0, case: 0, term: 0 };
  const subjectCounts: Record<QFormat, number> = { desc: 0, case: 0, term: 0 };
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

function pickFormat(weights: { format: QFormat; weight: number }[]): QFormat {
  const r = Math.random();
  let acc = 0;
  for (const { format, weight } of weights) {
    acc += weight;
    if (r < acc) return format;
  }
  return "desc";
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

const FORMAT_INSTRUCTION: Record<QFormat, string> = {
  desc: "知識説明形式で作成すること。対象の事象・概念・制度・理論等について、正しい/誤った説明を選ばせる（case_textはnullでよい）。",
  case: "事例形式で作成すること。「A精神保健福祉士」「Aさん」のように匿名の専門職またはクライエントを主人公にした短い場面を"
    + "case_textに書き、その場面における適切な認識・対応・該当する概念などをstemで問う"
    + "（例:「次のうち、Aさんの状態として、最も適切なものを1つ選びなさい」）。場面設定は根拠テキストの範囲で無理なく成立させ、"
    + "根拠テキストに無い事実は使わない。",
  term: "用語・名称選択形式で作成すること。選択肢を完全な説明文にせず、短い用語・固有名詞（病名・制度名・"
    + "役職名・分類名・数値等）そのものにする。stemは「正しい用語はどれか」と明示する必要は無く、"
    + "「次のうち、〜として、正しいものを1つ選びなさい」のような通常の定型文でよい（case_textはnullでよい）。"
    + "まれに、用語とその属性（時期・分類・段階等）の組み合わせを1行ずつ選択肢に並べ、正しい組み合わせの行を"
    + "1つ選ばせる形式にしてもよい（例: 発達段階とその時期のペアを5パターン並べ、正しいペアの行を選ばせる）。",
};

async function fewShotExamples(subject: string, targetFormat: QFormat, n = 3): Promise<string> {
  // correctが空の過去問（正答表が無い年度分）は「正答: 」が空欄になり手本として
  // 不完全なので、few-shotの材料からは除外する
  const hasAnswer = (q: { correct: unknown }) => Array.isArray(q.correct) && q.correct.length > 0;

  const { data: subjectRows } = await supabase()
    .from("past_questions")
    .select("stem, case_text, options, correct")
    .eq("subject", subject)
    .limit(40);
  const pool = (subjectRows ?? []).filter(hasAnswer).map((q) => ({
    ...q,
    format: classifyFormat(q.stem as string, q.case_text as string | null, q.options as string[]),
  }));
  if (pool.length === 0) return "（この科目の過去問例なし。一般的な国家試験の五肢択一形式に従うこと）";

  let targetMatches = pool.filter((q) => q.format === targetFormat).sort(() => Math.random() - 0.5);
  if (targetMatches.length === 0 && targetFormat !== "desc") {
    // この科目の少ないサンプルにたまたま無い場合、他科目から同じ形式の実例を借りて
    // 「書き方」だけ真似させる（内容は本問の根拠テキストの範囲で作らせるので問題ない）
    const { data: globalRows } = await supabase().from("past_questions").select("stem, case_text, options, correct").limit(400);
    targetMatches = (globalRows ?? [])
      .filter(hasAnswer)
      .map((q) => ({ ...q, format: classifyFormat(q.stem as string, q.case_text as string | null, q.options as string[]) }))
      .filter((q) => q.format === targetFormat)
      .sort(() => Math.random() - 0.5);
  }

  const chosen = targetMatches.slice(0, Math.min(n, 2));
  const remaining = pool.filter((q) => !chosen.includes(q)).sort(() => Math.random() - 0.5);
  const finalPicks = [...chosen, ...remaining.slice(0, Math.max(0, n - chosen.length))];

  return finalPicks
    .map((q, i) => {
      const opts = (q.options as string[]).map((o, j) => `${j + 1} ${o}`).join("\n");
      const caseText = q.case_text ? `〔事例〕${q.case_text}\n` : "";
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
 */
export async function generateOneQuestion(subject: string): Promise<GenerateResult> {
  const sb = supabase();
  const llm = await getLlmSettings();

  // 1. 出題対象のタクソノミー項目を選択（既存問題が少ない項目を優先）
  const item = await pickTaxonomyItem(subject);
  const topic = [item.major, item.middle, item.minor].filter(Boolean).join(" > ");

  // 2. HyDE検索で根拠チャンク+周辺チャンクを取得
  const { main, neighbor } = await retrieveForItem(item, llm);
  if (main.length === 0) throw new Error("チャンク検索結果が空です（埋め込み投入済みか確認）");

  // 3. 出題形式・正答数を科目ごとの実績比率から抽選（知識説明/事例/用語選択、五肢択一/択二）
  //    ＋few-shot（同科目の実際の過去問）＋この項目で既出の問題・根拠抜粋（重複回避用）
  const formatWeights = await computeFormatWeights(subject);
  const format = pickFormat(formatWeights);
  const answerCountWeights = await computeAnswerCountWeights(subject);
  const answerCount = pickAnswerCount(answerCountWeights);
  const fewShot = await fewShotExamples(subject, format);
  const { stems: pastStems, excerpts: pastExcerpts } = await existingCoverage(item.id);

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
- 問題形式は五肢択一（correct 1つ）と五肢択二（correct 2つ、問題文に「2つ選びなさい」と明記）の
  2種類があるが、今回どちらにするかは下の「今回作成する問題の正答数」で指定するので必ずそれに従うこと
  （指定を無視して常に1つにすると、実際の過去問の約24%を占める択二形式を再現できない）
- 正答は根拠テキストの記述から明確に導けること。根拠テキストに無い事実を使わない
- 誤答選択肢の作り方（最重要。過去問132問の誤答を分析した代表的な型を挙げる。
  4つの誤答それぞれに異なる型を組み合わせて使い、1つの型だけに偏らないこと。
  全部の型を無理に使う必要はない。単調な「ほぼ同じ作り方の誤答が4つ並ぶ」状態を避けるのが目的）:
  - 明らかに的外れな選択肢は禁止。受験者が迷う「近いが違う」ものにする
  - よくある型（内容を理解して初めて誤りだとわかる型を優先すること。d・eは使うとしても
    最小限にとどめる。過去問の誤答の大半はa〜cのように「一見どれも正しそうな専門的な記述」であり、
    d・eのような読めば違和感で気付ける誤答は少数派）:
    a. 類似・隣接概念とのすり替え（最頻出）: 同じ分野の別の概念・分類・理論の説明を、
       問われている対象の説明であるかのように提示する
    b. 人物と業績の取り違え: 実在の人物名は正しいが、別の人物の理論・功績・立場を割り当てる
    c. 制度・法律の主体/対象/要件のすり替え: 実施主体・対象範囲・要件を、実際とは異なる
       別のもの（別の職種・別の機関・別の年齢層など）に置き換える
    d. 数値・年号・期間の書き換え: 正しい記述中の数字（年齢・年数・期間・比率・順位等）だけを変える
    e. 過度な一般化・断定・除外: 「必ず」「〜できない」「〜のみ」など、実際は例外や幅がある
       ことを断定的・排他的に言い切る
    f. 事例問題では、一見丁寧・善意に見えるが実践的には不適切な対応（個人的経験の開示、
       パターナリスティックな判断の先取り、時期尚早な解釈の押し付けなど）
  - 各誤答は「なぜ誤りか」を根拠テキストまたは一般に確立した知識で説明できること
- 文体による正答の露呈を絶対に避けること（最重要・頻発する失敗。「避けるべき」という
  抽象的な注意だけでは実際には防げていないため、以下は必ず機械的に守ること）:
  - 「のみ」「だけ」「しか〜ない」「一切」「含まない」「対象外」「単独で」「常に」「必ず」
    「絶対に」等の断定的・排他的な語句を、ある選択肢が誤りであることの手がかりとして
    使わないこと。範囲や対象を誤らせたい場合（type e: 過度な一般化・除外）でも、これらの
    語句で否定する形にせず、type a〜cのように「別の主体・別の制度・別の対象・別の概念への
    すり替え」として誤りを作ること（例:「教育的リハビリは社会教育を含まない」ではなく、
    「教育的リハビリは主に学齢期の学校教育を対象とした発達支援である」のように、除外を
    明言せず対象を誤らせる形にする）
  - 例外: 根拠テキストが実際に「のみ」「必ず」等の断定的な記述をしている場合は、それが
    正答であっても誤答であってもそのまま使ってよい（不自然に言い換える必要はない）。
    禁止しているのは、根拠に無い断定語を誤答を作るためだけに追加することであって、
    根拠にある断定語を消すことではない
  - 5つの選択肢は、具体性・専門用語の密度・文の長さ・自信の度合いをすべて揃えて書くこと。
    正答だけが自然で誤答だけが不自然に極端・曖昧・簡潔、という差を作らない
  - 誤答は当てずっぽうの作文ではなく、実在する（教科書や一般知識に基づく）別の制度・人物・
    概念・数値を使うこと。存在しない概念をでっち上げた誤答は、知識が無くても「聞いたことがない
    から違う」と分かってしまい問題として成立しない
  - 書き終えたら選択肢1〜5だけを読み返し、「内容を一切知らなくても、断定語の有無や言い回しの
    強さだけで正答が推測できないか」を必ず自己チェックすること。推測できてしまう場合は
    該当箇所を上記の方法で書き直してから出力すること
- 手順は必ずこの順で行うこと（正答を先に決めてから理由を後付けしない）:
  1. まずexplanationsで選択肢1〜5それぞれを根拠テキストと照合し、正しいか誤りかを個別に吟味して書く
  2. その吟味結果だけを根拠にcorrectを決める（explanationsの結論とcorrectが食い違うことは絶対に許されない）
- explanations は選択肢1〜5の順に5つ。学習に役立つよう具体的に書く
- key_points はこの問題の周辺で覚えるべきことの整理（混同しやすい概念の対比など）
- citation_chunk_ids には実際に根拠として使ったチャンクのid（整数）を入れる

# 出題形式（過去問18科目・2回分の分析に基づく3分類。全体の目安比率は知識説明56%・
# 事例24%・用語選択19%だが、科目によって事例形式の出やすさにはかなり差がある。
# 今回どの形式で作るかは下の「今回作成する問題の出題形式」で指定するので、必ずそれに従うこと。
# 指定を無視すると知識説明形式ばかりに偏ってしまうため）
- 知識説明形式: ${FORMAT_INSTRUCTION.desc}
- 事例形式: ${FORMAT_INSTRUCTION.case}
- 用語選択形式: ${FORMAT_INSTRUCTION.term}`;

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
    if (q.correct.length < 1 || q.correct.length > 2) formatProblems.push("正答数が1〜2でない");
    if (q.correct.some((c) => c < 1 || c > 5)) formatProblems.push("正答番号が1〜5の範囲外");
    if ((q.question_type === "single") !== (q.correct.length === 1)) formatProblems.push("question_typeと正答数が不一致");
    if (q.correct.length > 0 && q.correct.length <= 2 && q.correct.length !== answerCount) {
      formatProblems.push(`指定した正答数(${answerCount}つ)に従っていない`);
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
   大量に無駄になる。5は「際立って露骨な場合」だけの最終防波堤として使うこと）`;
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

    const citedIds = new Set(q.citation_chunk_ids);
    const allChunks = [...main, ...neighbor];
    const citations = allChunks
      .filter((c) => citedIds.has(c.id))
      .map((c) => ({
        chunk_id: c.id,
        book: c.book,
        page_start: c.page_start,
        page_end: c.page_end,
        excerpt: c.content,
      }));
    // 引用が空なら上位チャンクを引用として付ける
    if (citations.length === 0 && main.length > 0) {
      citations.push({
        chunk_id: main[0].id,
        book: main[0].book,
        page_start: main[0].page_start,
        page_end: main[0].page_end,
        excerpt: main[0].content,
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
    });
  }

  return { questionId: null, status: "rejected", subject, topic, problems: lastProblems };
}
