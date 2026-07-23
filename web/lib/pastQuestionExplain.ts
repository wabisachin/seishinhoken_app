import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./llm";
import { supabase } from "./supabase";
import { searchChunks, type RetrievedChunk } from "./retrieval";
import { logUsage } from "./usageLog";

// 過去問は正答表しか無く解説が無い。本番と同じ解説を後付けで作る。呼び出し回数が多いのと
// 精度がそこまで求められないため、生成AIの主モデルと同じgpt-5.6-luna固定にする
// （管理画面の設定に依存させない。高価なモデルを誤って使わないようにするための固定）
const EXPLAIN_MODEL = { provider: "openai" as const, model: "gpt-5.6-luna" };

const explainSchema = z.object({
  explanations: z
    .array(z.string())
    .describe("選択肢1〜5それぞれについて、根拠テキストに照らして正しいか誤りかを説明する解説文（学習に役立つよう具体的に）"),
  key_points: z.string().describe("この問題の周辺で押さえるべき知識の整理（混同しやすい概念の対比など）"),
  citation_chunk_ids: z.array(z.number().int()).describe("根拠として実際に使用したチャンクIDの配列"),
  option_citations: z
    .array(
      z.array(
        z.object({
          chunk_id: z.number().int(),
          quote: z.string().describe("この選択肢の解説の根拠にした、チャンク本文中の一節（目安20〜60字、正確に抜き出せなければ空文字でよい）"),
        }),
      ),
    )
    .describe("選択肢1〜5それぞれについて、根拠にしたチャンクIDと該当箇所の引用"),
});

export type PastQuestionRow = {
  id: number;
  subject: string;
  case_text: string | null;
  stem: string;
  options: string[];
  correct: number[];
};

function chunkBlock(chunks: RetrievedChunk[]): string {
  return chunks.map((c) => `[chunk_id=${c.id}] (${c.book} p.${c.page_start}-${c.page_end})\n${c.content}`).join("\n\n");
}

/**
 * 過去問はすでに実際の問題文・選択肢・正答があるため、HyDE（仮の解説文を書いて検索する）を
 * 経由する必要が無い。問題文・事例文・選択肢そのものを検索クエリにして直接教科書チャンクを探す
 * （generation.tsのretrieveForItemより単純で、かつ実データなので検索精度も高い）。
 */
async function retrieveForPastQuestion(q: PastQuestionRow): Promise<RetrievedChunk[]> {
  const query = [q.case_text, q.stem, ...q.options].filter(Boolean).join("\n");
  return searchChunks(query, 10);
}

/**
 * 過去問1問に解説を生成し、past_questionsに保存する。stem/options/correctなど問題本体は
 * 一切変更しない（LLMには「これは確定済みの事実として解説だけ書け」と明示する）。
 */
export async function explainPastQuestion(q: PastQuestionRow): Promise<void> {
  const chunks = await retrieveForPastQuestion(q);
  const optionsList = q.options.map((o, i) => `${i + 1} ${o}`).join("\n");

  const prompt = `あなたは精神保健福祉士国家試験の過去問解説を書く専門家です。
以下は実際に出題された過去問です。問題文・選択肢・正答はすでに確定した事実であり、
変更・疑義の呈示は一切禁止です。根拠テキスト（教科書の抜粋）を参考に、選択肢1〜5それぞれが
なぜ正しい、または誤りなのかを解説してください。

# 問題
${q.case_text ? `〔事例〕${q.case_text}\n` : ""}${q.stem}
${optionsList}
正答: ${q.correct.join(", ")}

# 根拠テキスト（教科書からの抜粋。事実の根拠はこの範囲を優先し、記述が無い部分のみ
一般に確立した知識で補うこと）
${chunkBlock(chunks)}

各選択肢の解説は具体的に書くこと。正答・誤答の判定そのものは上記の正答を絶対の前提とし、
疑問を呈したり異なる結論を示唆したりしないこと。`;

  const model = getModel(EXPLAIN_MODEL);
  const { object, usage } = await generateObject({ model, schema: explainSchema, prompt });
  await logUsage({
    source: "past-question-explain",
    subject: q.subject,
    provider: EXPLAIN_MODEL.provider,
    model: EXPLAIN_MODEL.model,
    usage,
  });

  // generation.tsのcitations構築ロジックと同じ形（chunk_id/book/page/excerpt/supports/quotes）に揃える
  const optionChunkIds = object.option_citations.map((entries) => entries.map((e) => e.chunk_id));
  const citedIds = new Set([...object.citation_chunk_ids, ...optionChunkIds.flat()]);
  const citations = chunks
    .filter((c) => citedIds.has(c.id))
    .map((c) => {
      const quotes = object.option_citations.flatMap((entries, idx) =>
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
  if (citations.length === 0 && chunks.length > 0) {
    citations.push({ chunk_id: chunks[0].id, book: chunks[0].book, page_start: chunks[0].page_start, page_end: chunks[0].page_end, excerpt: chunks[0].content, supports: [], quotes: [] });
  }

  const { error } = await supabase()
    .from("past_questions")
    .update({
      explanations: object.explanations,
      key_points: object.key_points,
      citations,
      explained_at: new Date().toISOString(),
    })
    .eq("id", q.id);
  if (error) throw new Error(error.message);
}

/** まだ解説が無い過去問をすべて取得する（explained_atがnullのもの）。 */
export async function fetchUnexplainedPastQuestions(limit = 300): Promise<PastQuestionRow[]> {
  const { data, error } = await supabase()
    .from("past_questions")
    .select("id, subject, case_text, stem, options, correct")
    .is("explained_at", null)
    .not("correct", "eq", "[]")
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data as PastQuestionRow[];
}
