import { generateText } from "ai";
import { getModel } from "./llm";
import { embedQuery } from "./voyage";
import { supabase } from "./supabase";
import { logUsage } from "./usageLog";
import { DEFAULT_LLM, type LlmSettings } from "./types";

export type RetrievedChunk = {
  id: number;
  document_id: number;
  book: string;
  content: string;
  page_start: number;
  page_end: number;
  similarity: number;
};

export type TaxonomyItem = {
  id: number;
  subject: string;
  major: string;
  middle: string | null;
  minor: string | null;
};

/**
 * HyDE（Hypothetical Document Embeddings）: 出題基準の項目名（例:「認知症 > BPSD > 対応」）は
 * 短く抽象的すぎて、そのまま埋め込みベクトル検索にかけても実際の教科書チャンクと類似度が
 * 上がりにくい。そこで「教科書に書かれていそうな解説文」をLLMに一度書かせ、その"文章としての
 * トピックの雰囲気"だけを検索クエリの埋め込みに使う。
 *
 * 重要: この解説文はあくまで検索クエリを作るための踏み台であり、事実の根拠としては
 * 一切使わない。実際に問題生成のプロンプトに「根拠テキスト」として渡るのは、この検索で
 * ヒットした実物の教科書チャンク（chunks テーブルの content、PDFから抽出した実テキスト）
 * だけであり、citations に載る抜粋も同じ実チャンクの content そのもの。
 * 呼び出し元（generation.ts）もこの passage 自体は受け取らず main/neighbor（実チャンク）
 * だけを使う設計にしている。
 */
export async function hydePassage(item: TaxonomyItem, llm?: Partial<LlmSettings>): Promise<string> {
  const topic = [item.subject, item.major, item.middle, item.minor].filter(Boolean).join(" > ");
  const { text, usage } = await generateText({
    model: getModel(llm),
    prompt: `あなたは精神保健福祉士養成課程の教科書の執筆者です。
次のトピックについて、教科書に実際に書かれていそうな解説文を250字程度で書いてください。
重要な専門用語・法律名・制度名・数値を具体的に含めてください。解説文のみを出力してください。

トピック: ${topic}`,
  });
  await logUsage({
    source: "hyde",
    subject: item.subject,
    provider: llm?.provider ?? DEFAULT_LLM.provider,
    model: llm?.model ?? DEFAULT_LLM.model,
    usage,
  });
  return text.trim();
}

/** pgvector 類似検索 */
export async function searchChunks(query: string, count = 8): Promise<RetrievedChunk[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await supabase().rpc("match_chunks", {
    query_embedding: embedding,
    match_count: count,
  });
  if (error) throw new Error(`match_chunks failed: ${error.message}`);
  return data as RetrievedChunk[];
}

/**
 * 出題対象のタクソノミー項目に対して根拠チャンクを取得する。
 * 本体チャンク + 誤答選択肢の材料になる周辺チャンクを返す。
 */
export async function retrieveForItem(item: TaxonomyItem, llm?: Partial<LlmSettings>) {
  const passage = await hydePassage(item, llm);
  const main = await searchChunks(passage, 8);
  // 周辺トピック: 同科目の別の大項目名で軽く検索して「近いが違う」材料を得る
  const sb = supabase();
  const { data: siblings } = await sb
    .from("taxonomy")
    .select("id, subject, major, middle, minor")
    .eq("subject", item.subject)
    .neq("id", item.id)
    .limit(50);
  let neighbor: RetrievedChunk[] = [];
  if (siblings && siblings.length > 0) {
    const pick = siblings[Math.floor(Math.random() * siblings.length)] as TaxonomyItem;
    const q = [pick.major, pick.middle, pick.minor].filter(Boolean).join(" ");
    const found = await searchChunks(q, 3);
    const mainIds = new Set(main.map((c) => c.id));
    neighbor = found.filter((c) => !mainIds.has(c.id));
  }
  return { passage, main, neighbor };
}
