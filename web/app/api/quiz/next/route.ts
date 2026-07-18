import { NextRequest, NextResponse, after } from "next/server";
import { getOrGenerateNext, topUpSubject, topUpCaseAxisStock } from "@/lib/questionSupply";
import type { CaseAxis } from "@/lib/generation";
import { logError } from "@/lib/errorLog";

// 出題直後フックのtopUpSubject（after()内）は、このmaxDurationを超えると強制終了され、
// topUpInFlightの解除(finally)が走らずその科目が永久にスキップされ続けるバグになる
// （実際にVercelの60秒タイムアウトで発生を確認済み）。回数ではなく内部時間予算
// （TOPUP_HOOK_TIME_BUDGET_MS、下記）で自発的に止まるようにし、maxDurationは
// それより確実に大きい値にして「自分から止まる前にVercelに殺される」ことを防ぐ。
export const maxDuration = 300;

// maxDurationより確実に短い時間で自発的に打ち切る（Vercelに強制終了される前に
// finallyで後片付けを終わらせるため）。ユーザーは1日に何問も解く前提なので、出題の
// たびにこの予算内で目標の5問に近づけるだけ近づける（却下が続いても1回もこれで
// 諦めない。1問で打ち切ると却下が続いた時にストックが全く増えないままになるため）。
const TOPUP_HOOK_TIME_BUDGET_MS = 270_000;

/**
 * 科目別演習の「次の1問」を返す。無ければ高々1回だけその場で生成を試みる
 * （リクエスト駆動・バックグラウンドループ無し。詳細はlib/questionSupply.ts参照）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const subject: string | undefined = body.subject;
    if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
    const excludeIds: number[] = Array.isArray(body.excludeIds) ? body.excludeIds : [];
    const caseAxis: CaseAxis | undefined = body.caseAxis === "case" || body.caseAxis === "nocase" ? body.caseAxis : undefined;
    const result = await getOrGenerateNext(subject, excludeIds, caseAxis);

    // ストックの「消費」は回答送信時ではなく、問題が画面に出される（＝取り出される）
    // このタイミングで起きたとみなす。after()はレスポンス返却後に実行されるため、
    // ユーザーの待ち時間には一切影響しない（かんばん方式の補充トリガー）。
    if (result.question) {
      after(() =>
        topUpSubject(subject, { timeBudgetMs: TOPUP_HOOK_TIME_BUDGET_MS }).catch((e) =>
          logError("quiz-next-topup", e, { subject }),
        ),
      );
      after(() =>
        topUpCaseAxisStock(subject, { timeBudgetMs: TOPUP_HOOK_TIME_BUDGET_MS }).catch((e) =>
          logError("quiz-next-axis-topup", e, { subject }),
        ),
      );
    }

    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
