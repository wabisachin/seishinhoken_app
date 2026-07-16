import { supabase } from "./supabase";

/**
 * 外部サービス（LLM課金上限・レート制限、Voyage、Supabase等）で起きたエラーを
 * サーバーログ＋DBの両方に記録する。ログ保存自体が失敗しても元のエラー処理を
 * 邪魔しないよう、ここで起きた例外は握りつぶす（呼び出し元には伝播させない）。
 */
export async function logError(source: string, error: unknown, extra?: Record<string, unknown>): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const detail = [error instanceof Error ? error.stack : undefined, extra ? JSON.stringify(extra) : undefined]
    .filter(Boolean)
    .join("\n");

  console.error(`[${source}]`, message, extra ?? "");

  try {
    await supabase().from("error_logs").insert({ source, message, detail: detail || null });
  } catch (e) {
    console.error("[errorLog] failed to persist error log", e);
  }
}
