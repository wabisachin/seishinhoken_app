import { NextRequest, NextResponse } from "next/server";
import { topUpAllSubjects, topUpExamPool, topUpCaseAxisAllSubjects } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";

// Vercelの関数タイムアウトを最大限使う（Fluid Compute既定は300秒）
export const maxDuration = 300;
// 通常プール・実戦模試プール・出題形式別ストックの補充は並列で走らせる（足し算ではなく
// 同時実行なので、いずれも270秒予算のままmaxDuration=300秒に収まる）。
const TOPUP_EXAM_TIME_BUDGET_MS = 270_000;
const TOPUP_AXIS_TIME_BUDGET_MS = 270_000;

/**
 * 実際にLLM生成（課金）を伴うエンドポイントのため、keepaliveと違いCRON_SECRETで保護する。
 * Vercel Cronは`CRON_SECRET`環境変数が設定されていると、呼び出し時に自動でこのヘッダーを
 * 付与してくれる（https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs）。
 */
export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const [{ results, remaining }, examResult, axisResult] = await Promise.all([
      topUpAllSubjects(),
      topUpExamPool({ timeBudgetMs: TOPUP_EXAM_TIME_BUDGET_MS }),
      topUpCaseAxisAllSubjects({ timeBudgetMs: TOPUP_AXIS_TIME_BUDGET_MS }),
    ]);
    return NextResponse.json({ ok: true, results, remaining, exam: examResult, caseAxis: axisResult });
  } catch (e) {
    await logError("cron-topup", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
