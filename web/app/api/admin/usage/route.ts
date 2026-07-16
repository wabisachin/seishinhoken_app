import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import { supabase } from "@/lib/supabase";

type UsageRow = {
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase()
    .from("llm_usage")
    .select("provider, model, input_tokens, cached_input_tokens, output_tokens, cost_usd");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as UsageRow[];

  const totals = rows.reduce(
    (acc, r) => {
      acc.inputTokens += r.input_tokens;
      acc.cachedInputTokens += r.cached_input_tokens;
      acc.outputTokens += r.output_tokens;
      acc.costUsd += Number(r.cost_usd);
      return acc;
    },
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
  );

  const byModelMap = new Map<
    string,
    { provider: string; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number }
  >();
  for (const r of rows) {
    const key = `${r.provider}:${r.model}`;
    const cur = byModelMap.get(key) ?? {
      provider: r.provider,
      model: r.model,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    cur.inputTokens += r.input_tokens;
    cur.cachedInputTokens += r.cached_input_tokens;
    cur.outputTokens += r.output_tokens;
    cur.costUsd += Number(r.cost_usd);
    byModelMap.set(key, cur);
  }
  const byModel = [...byModelMap.values()].sort((a, b) => b.costUsd - a.costUsd);

  return NextResponse.json({ totals, byModel, callCount: rows.length });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { error } = await supabase().from("llm_usage").delete().gte("id", 0);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
