import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { generateMonthlyReport } from "@/lib/monthlyReport";
import { logError } from "@/lib/errorLog";

// LLM生成(2段階)を本人・動作テスト用の両方ぶん直列で行うため、時間に余裕を持たせる。
export const maxDuration = 300;

/** 前月を"YYYY-MM"で返す（毎月1日に走らせて、終わったばかりの月を振り返る）。 */
function previousMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed。0ならその年の1月なので前年12月になる
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 12 : m;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

/**
 * 月次振り返りレポートの生成cron。日次のストック補充cronと異なり、本人(self)・動作テスト用
 * (test)の両方で実行する ── 動作テスト用でも同じ機能を確認できるようにするための明示的な
 * 方針（questionSupply.tsの日次補充が本人限定なのとは意図的に異なる）。
 * `?month=YYYY-MM` を指定すると対象月を上書きできる（手動再生成・動作確認用）。
 * unique(profile, period_month) 制約により、同じ月に対して再実行しても重複生成しない
 * （既存行があればスキップする）。
 */
export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const periodMonth = req.nextUrl.searchParams.get("month") ?? previousMonth(new Date());
    const sb = supabase();
    const results: Record<string, string> = {};

    for (const profile of ["self", "test"] as const) {
      try {
        const { data: existing } = await sb
          .from("monthly_reports")
          .select("id")
          .eq("profile", profile)
          .eq("period_month", `${periodMonth}-01`)
          .maybeSingle();
        if (existing) {
          results[profile] = "already-exists";
          continue;
        }
        const created = await generateMonthlyReport(profile, periodMonth);
        results[profile] = created ? `created:${created.id}` : "skipped:no-data";
      } catch (e) {
        await logError("monthly-report", e, { profile, periodMonth });
        results[profile] = "error";
      }
    }

    return NextResponse.json({ ok: true, periodMonth, results });
  } catch (e) {
    await logError("monthly-report-cron", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
