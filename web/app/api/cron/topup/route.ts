import { NextRequest, NextResponse } from "next/server";
import { listSubjects } from "@/lib/subjects";
import { topUpSubject } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";

// Vercelの関数タイムアウトを最大限使う（Fluid Compute既定は300秒）
export const maxDuration = 300;

const CONCURRENCY = 4;
// 関数タイムアウトに対してマージンを残す。予算内で終わらなかった科目は
// 「未出題ストックがまだ少ない」状態のまま残るだけで、翌日また同じ判定で拾われる。
const TIME_BUDGET_MS = 270_000;

/**
 * 1日1回のVercel Cronから叩かれる。全科目の「未出題ストック」を毎回数え直し、
 * STOCK_TARGET未満の科目だけを対象に補充する（既に足りている科目は何もしない）。
 * 生成そのものは既存のコスト上限（SUBJECT_TARGET/HARD_CAP_TOTAL）に必ず従うため、
 * 何度実行しても際限なく増え続けることはない。
 */
/**
 * 実際にLLM生成（課金）を伴うエンドポイントのため、keepaliveと違いCRON_SECRETで保護する。
 * Vercel Cronは`CRON_SECRET`環境変数が設定されていると、呼び出し時に自動でこのヘッダーを
 * 付与してくれる（https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs）。
 */
export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const start = Date.now();
  const results: Record<string, number> = {};
  try {
    const subjects = await listSubjects();
    const queue = [...subjects];

    async function worker() {
      while (queue.length > 0 && Date.now() - start < TIME_BUDGET_MS) {
        const subject = queue.shift();
        if (!subject) break;
        try {
          const { generated } = await topUpSubject(subject);
          results[subject] = generated;
        } catch (e) {
          await logError("cron-topup", e, { subject });
          results[subject] = -1;
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    return NextResponse.json({ ok: true, results, remaining: queue, elapsedMs: Date.now() - start });
  } catch (e) {
    await logError("cron-topup", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
