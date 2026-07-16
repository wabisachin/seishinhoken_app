import { supabase } from "./supabase";
import { DEFAULT_LLM, LlmSettings } from "./types";

/**
 * 問題生成に使うLLMはここ（DB）だけが正。クライアントから指定させることは絶対にしない
 * （/admin の管理者操作からのみ変更できる。詳細はlib/adminAuth.ts参照）。
 */
export async function getLlmSettings(): Promise<LlmSettings> {
  const { data } = await supabase().from("app_settings").select("llm_provider, llm_model").eq("id", 1).maybeSingle();
  if (!data) return DEFAULT_LLM;
  return { provider: data.llm_provider as LlmSettings["provider"], model: data.llm_model as string };
}

export async function setLlmSettings(settings: LlmSettings): Promise<void> {
  const { error } = await supabase()
    .from("app_settings")
    .update({ llm_provider: settings.provider, llm_model: settings.model, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(error.message);
}
