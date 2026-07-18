import { NextResponse } from "next/server";
import { getCurrentExamAttempt, countRoundsThisMonth } from "@/lib/examMode";
import { EXAM_MONTHLY_LIMIT } from "@/lib/examFormat";
import { logError } from "@/lib/errorLog";

/** full-mockページの選択画面はこれ1本で描画する。 */
export async function GET() {
  try {
    const [current, roundsThisMonth] = await Promise.all([getCurrentExamAttempt("self"), countRoundsThisMonth("self")]);
    const remainingThisMonth = Math.max(0, EXAM_MONTHLY_LIMIT - roundsThisMonth);
    if (!current) {
      return NextResponse.json({ hasInProgress: false, remainingThisMonth });
    }
    return NextResponse.json({
      hasInProgress: true,
      examAttemptId: current.id,
      commonStatus: current.common_status,
      specializedStatus: current.specialized_status,
      remainingThisMonth,
    });
  } catch (e) {
    await logError("exam-state", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
