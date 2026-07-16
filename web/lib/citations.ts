import type { Citation } from "./types";

/**
 * 表示用に、同じ書籍・同じページ範囲の引用をまとめる。チャンク分割の都合で
 * 隣接する2チャンクが同じページ範囲になることがあり、根拠を「場所」だけで
 * 表示するようになった今、そのままだと同じ行が重複して見えてしまうため。
 */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const result: Citation[] = [];
  for (const c of citations) {
    const key = `${c.book}|${c.page_start}|${c.page_end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}
