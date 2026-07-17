import { NextRequest, NextResponse } from "next/server";
import { topUpAllSubjects } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";

// Vercelの関数タイムアウトを最大限使う（Fluid Compute既定は300秒）
export const maxDuration = 300;

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
    const { results, remaining } = await topUpAllSubjects();
    return NextResponse.json({ ok: true, results, remaining });
  } catch (e) {
    await logError("cron-topup", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
