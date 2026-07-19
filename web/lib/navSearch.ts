import { embedQuery } from "./voyage";
import { supabase } from "./supabase";

export type NavPageMatch = {
  id: number;
  book: string;
  page_number: number;
  title: string | null;
  image_path: string;
  similarity: number;
};

/**
 * 国試ナビのページ意味検索。lib/retrieval.tsのsearchChunks()と同じ形の薄いラッパーだが、
 * こちらはHyDEを使わない（ユーザーの検索語は出題基準の抽象項目名と違い、ある程度
 * 具体的な語句を想定しているため）。表示専用インデックス(nav_pages)を参照するのみで、
 * 問題生成のRAG検索(chunks)とは無関係。
 */
export async function searchNavPages(query: string, count = 5): Promise<NavPageMatch[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await supabase().rpc("match_nav_pages", {
    query_embedding: embedding,
    match_count: count,
  });
  if (error) throw new Error(`match_nav_pages failed: ${error.message}`);
  return data as NavPageMatch[];
}
