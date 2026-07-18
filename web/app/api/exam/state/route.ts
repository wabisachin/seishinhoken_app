import { NextResponse } from "next/server";
import { getCurrentExamAttempt, countRoundsThisMonth } from "@/lib/examMode";
import { EXAM_MONTHLY_LIMIT } from "@/lib/examFormat";
import { getExamReadyRounds } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";

/**
 * full-mockページの選択画面はこれ1本で描画する。commonReady/specializedReadyは
 * 「そのパートを今すぐ最後まですらすら受けられるだけの在庫があるか」を表す
 * （在庫が本番出題数に届いていない科目が1つでもあれば false）。未着手のパートを
 * 選択画面で灰色表示にし、生成が終わるまで受験を始めさせないために使う。
 */
export async function GET() {
  try {
    const [current, roundsThisMonth, readyRounds] = await Promise.all([
      getCurrentExamAttempt("self"),
      countRoundsThisMonth("self"),
      getExamReadyRounds(),
    ]);
    const remainingThisMonth = Math.max(0, EXAM_MONTHLY_LIMIT - roundsThisMonth);
    const commonReady = readyRounds.common >= 1;
    const specializedReady = readyRounds.specialized >= 1;
    if (!current) {
      return NextResponse.json({ hasInProgress: false, remainingThisMonth, commonReady, specializedReady });
    }
    return NextResponse.json({
      hasInProgress: true,
      examAttemptId: current.id,
      commonStatus: current.common_status,
      specializedStatus: current.specialized_status,
      remainingThisMonth,
      commonReady,
      specializedReady,
    });
  } catch (e) {
    await logError("exam-state", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
