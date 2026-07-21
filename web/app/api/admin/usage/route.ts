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

// SupabaseのREST API（PostgREST）は明示的なrangeを指定しない場合、既定で最大1000件しか
// 返さない。llm_usageは呼び出しのたびに増え続けるテーブルのため、行数が1000件を超えると
// 集計対象が古い（またはある時点までの）1000件に固定されてしまい、それ以降の利用量が
// 管理画面の集計に一切反映されなくなる不具合があった（実際に4000件超まで積み上がっており、
// 表示上の使用量が本当の使用量から大きく乖離していた）。ページングして全件を取得する。
async function fetchAllUsageRows(): Promise<UsageRow[]> {
  const PAGE_SIZE = 1000;
  const rows: UsageRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase()
      .from("llm_usage")
      .select("provider, model, input_tokens, cached_input_tokens, output_tokens, cost_usd")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as UsageRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let rows: UsageRow[];
  try {
    rows = await fetchAllUsageRows();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }

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
