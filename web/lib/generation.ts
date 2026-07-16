import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./llm";
import { supabase } from "./supabase";
import { retrieveForItem, RetrievedChunk, TaxonomyItem } from "./retrieval";
import { DEFAULT_LLM, LlmSettings } from "./types";

// 構造化出力スキーマ（プロバイダ非対応の制約は避け、後段で手動検証する）
// フィールド順序が生成順序に対応するため、必ず「各選択肢の正誤を吟味(explanations)」→
// 「その結論から正答を確定(correct)」の順にする。逆順だと正答を先に決め打ちしてから
// 解説を書くことになり、両者が矛盾する（＝検証で弾かれる）ケースが多発したため。
const questionSchema = z.object({
  question_type: z.enum(["single", "multi"]).describe("正答が1つならsingle、2つならmulti"),
  stem: z.string().describe("問題文。本番の国家試験の文体（〜として、適切なものを1つ選びなさい 等）"),
  case_text: z.string().nullable().describe("事例問題の場合の事例文。通常問題ならnull"),
  options: z.array(z.string()).describe("選択肢5つ"),
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

function chunkBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) => `<chunk id="${c.id}" book="${c.book}" pages="${c.page_start}-${c.page_end}">\n${c.content}\n</chunk>`)
    .join("\n\n");
}

async function fewShotExamples(subject: string, n = 3): Promise<string> {
  const { data } = await supabase()
    .from("past_questions")
    .select("stem, case_text, options, correct")
    .eq("subject", subject)
    .limit(20);
  const pool = data ?? [];
  if (pool.length === 0) return "（この科目の過去問例なし。一般的な国家試験の五肢択一形式に従うこと）";
  const picked = pool.sort(() => Math.random() - 0.5).slice(0, n);
  return picked
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

/** 指定科目からタクソノミー項目を1つ選んで問題を1問生成・検証・保存する */
export async function generateOneQuestion(
  subject: string,
  llm?: Partial<LlmSettings>,
): Promise<GenerateResult> {
  const sb = supabase();

  // 1. 出題対象のタクソノミー項目をランダム選択
  const { data: items, error: taxError } = await sb
    .from("taxonomy")
    .select("id, subject, major, middle, minor")
    .eq("subject", subject);
  if (taxError || !items || items.length === 0) {
    throw new Error(`taxonomy not found for subject=${subject}（extract_kijun.py 実行済みか確認）`);
  }
  const item = items[Math.floor(Math.random() * items.length)] as TaxonomyItem;
  const topic = [item.major, item.middle, item.minor].filter(Boolean).join(" > ");

  // 2. HyDE検索で根拠チャンク+周辺チャンクを取得
  const { main, neighbor } = await retrieveForItem(item, llm);
  if (main.length === 0) throw new Error("チャンク検索結果が空です（埋め込み投入済みか確認）");

  // 3. few-shot（同科目の実際の過去問）
  const fewShot = await fewShotExamples(subject);

  const basePrompt = `あなたは精神保健福祉士国家試験の作問委員です。教科書の記述のみを根拠に、本番と同水準の問題を1問作成してください。

# 出題対象
科目: ${subject}
出題基準の項目: ${topic}

# 根拠テキスト（教科書からの抜粋。この内容のみを事実の根拠とすること）
${chunkBlock(main)}

# 周辺トピックのテキスト（誤答選択肢の材料に使ってよい）
${chunkBlock(neighbor)}

# 実際の過去問の文体・形式（これに厳密に合わせる）
${fewShot}

# 作問ルール
- 問題形式: 五肢択一（correct 1つ）または五肢択二（correct 2つ、問題文に「2つ選びなさい」と明記）。事例問題にしてもよい
- 正答は根拠テキストの記述から明確に導けること。根拠テキストに無い事実を使わない
- 誤答選択肢の作り方（最重要）:
  - 明らかに的外れな選択肢は禁止。受験者が迷う「近いが違う」ものにする
  - 周辺トピックの用語・別の法律や制度・別の年号や数値・類似の人物や理論との取り違え、を材料にする
  - 各誤答は「なぜ誤りか」を根拠テキストまたは一般に確立した知識で説明できること
- 手順は必ずこの順で行うこと（正答を先に決めてから理由を後付けしない）:
  1. まずexplanationsで選択肢1〜5それぞれを根拠テキストと照合し、正しいか誤りかを個別に吟味して書く
  2. その吟味結果だけを根拠にcorrectを決める（explanationsの結論とcorrectが食い違うことは絶対に許されない）
- explanations は選択肢1〜5の順に5つ。学習に役立つよう具体的に書く
- key_points はこの問題の周辺で覚えるべきことの整理（混同しやすい概念の対比など）
- citation_chunk_ids には実際に根拠として使ったチャンクのid（整数）を入れる`;

  const model = getModel(llm);
  const modelName = llm?.model ?? DEFAULT_LLM.model;

  let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = lastProblems.length
      ? `\n\n# 前回生成の問題点（必ず修正すること）\n- ${lastProblems.join("\n- ")}`
      : "";
    const { object: q } = await generateObject({
      model,
      schema: questionSchema,
      prompt: basePrompt + retryNote,
    });

    // 形式チェック
    const formatProblems: string[] = [];
    if (q.options.length !== 5) formatProblems.push("選択肢が5つでない");
    if (q.explanations.length !== 5) formatProblems.push("解説が5つでない");
    if (q.correct.length < 1 || q.correct.length > 2) formatProblems.push("正答数が1〜2でない");
    if (q.correct.some((c) => c < 1 || c > 5)) formatProblems.push("正答番号が1〜5の範囲外");
    if ((q.question_type === "single") !== (q.correct.length === 1)) formatProblems.push("question_typeと正答数が不一致");
    if (formatProblems.length > 0) {
      lastProblems = formatProblems;
      continue;
    }

    // 4. 検証パス: 根拠テキストと照合
    const optionsList = q.options.map((o, i) => `${i + 1} ${o}`).join("\n");
    const { object: verdict } = await generateObject({
      model,
      schema: verifySchema,
      prompt: `あなたは試験問題の校閲者です。次の問題を根拠テキストと照合し、以下をすべて検証してください:
1. 正答（${q.correct.join(", ")}）が根拠テキストの記述で支持されること
2. 各誤答選択肢が根拠テキストと矛盾する、または明確に誤りであること（正答になり得る誤答が無いこと）
3. 問題文・選択肢に根拠テキストに無い事実の捏造が無いこと
4. 五肢択一/択二として成立していること（正答が一意に定まる）

# 根拠テキスト
${chunkBlock(main)}
${chunkBlock(neighbor)}

# 問題
${q.case_text ? `〔事例〕${q.case_text}\n` : ""}${q.stem}
${optionsList}
正答: ${q.correct.join(", ")}`,
    });

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

  return { questionId: null, status: "rejected", subject, topic, problems: lastProblems };
}
