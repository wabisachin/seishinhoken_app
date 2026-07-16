import { supabase } from "./supabase";

/**
 * $ / 1M トークンの単価表。cachedInputはプロンプトキャッシュがヒットした分の単価
 * （不明なモデルは input の50%引きで概算する）。ここに無いモデルはコスト0として
 * 記録する（トークン数自体は正しく残るので、後から単価を追加すれば集計し直せる）。
 */
const PRICING: Record<string, { input: number; output: number; cachedInput?: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5.6-luna": { input: 1.0, output: 6.0 },
  "gpt-5.6-terra": { input: 2.5, output: 15.0 },
  "gpt-5.6-sol": { input: 5.0, output: 30.0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const cachedRate = p.cachedInput ?? p.input * 0.5;
  const billedInput = Math.max(inputTokens - cachedInputTokens, 0);
  return (billedInput * p.input + cachedInputTokens * cachedRate + outputTokens * p.output) / 1_000_000;
}

/** トークン使用量を記録する。失敗してもLLM呼び出し自体は止めたくないので例外は投げない */
export async function logUsage(params: {
  source: "hyde" | "generate" | "verify";
  subject?: string;
  provider: string;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
}): Promise<void> {
  const inputTokens = params.usage.inputTokens ?? 0;
  const outputTokens = params.usage.outputTokens ?? 0;
  const cachedInputTokens = params.usage.cachedInputTokens ?? 0;
  const cost = estimateCostUsd(params.model, inputTokens, outputTokens, cachedInputTokens);
  try {
    await supabase().from("llm_usage").insert({
      source: params.source,
      subject: params.subject ?? null,
      provider: params.provider,
      model: params.model,
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
    });
  } catch (e) {
    console.error("[usageLog] failed to persist usage log", e);
  }
}
