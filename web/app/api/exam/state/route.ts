import { NextRequest, NextResponse, after } from "next/server";
import { getCurrentExamAttempt, countRoundsThisMonth, hasStartedRoundToday } from "@/lib/examMode";
import { EXAM_MONTHLY_LIMIT } from "@/lib/examFormat";
import { getExamReadyRounds, topUpExamPool } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";

// after()で在庫補充を走らせる場合に備え、cron/exam-startと同じくmaxDurationを確保する
export const maxDuration = 300;
const TOPUP_HOOK_TIME_BUDGET_MS = 270_000;
// 在庫不足を検知するたびに毎回270秒分の生成を走らせると、ページを何度も開いた/
// 「もう一度確認する」を連打しただけで重複起動してしまう。同一インスタンスが温まっている
// 間だけの簡易的なクールダウンでよい（別インスタンスに当たった場合の多少の重複は
// 許容——却下判定と同じくactive>=targetチェックがあるので大きな無駄にはならない）
const TRIGGER_COOLDOWN_MS = 60_000;
// 本人・動作テスト用はそれぞれ独立して補充が走るため、クールダウンもprofileごとに分ける
// （片方の直近トリガーがもう片方のトリガーを塞いでしまわないようにするため）。
const lastTriggeredAt = new Map<string, number>();

/**
 * full-mockページの選択画面はこれ1本で描画する。commonReady/specializedReadyは
 * 「そのパートを今すぐ最後まですらすら受けられるだけの在庫があるか」を表す
 * （在庫が本番出題数に届いていない科目が1つでもあれば false）。未着手のパートを
 * 選択画面で灰色表示にし、生成が終わるまで受験を始めさせないために使う。
 *
 * 在庫が足りない間はボタン自体が押せない（disabled）ため、/api/exam/startのafter()
 * フックは「ユーザーが開始ボタンを押す」ことを前提にしていると発火しない
 * （ボタンが押せない状態=在庫不足そのものなので、押せるようになるまで永久に
 * トリガーされないカタツムリ問題になっていた）。そのため、実際にページから
 * ポーリングされるこちらのGETで在庫不足を検知した時点で補充をトリガーする。
 */
export async function GET(request: NextRequest) {
  try {
    const profile = request.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const [current, roundsThisMonth, readyRounds, startedToday] = await Promise.all([
      getCurrentExamAttempt(profile),
      countRoundsThisMonth(profile),
      getExamReadyRounds(profile),
      hasStartedRoundToday(profile),
    ]);
    const remainingThisMonth = Math.max(0, EXAM_MONTHLY_LIMIT - roundsThisMonth);
    const commonReady = readyRounds.common >= 1;
    const specializedReady = readyRounds.specialized >= 1;

    if ((!commonReady || !specializedReady) && Date.now() - (lastTriggeredAt.get(profile) ?? 0) > TRIGGER_COOLDOWN_MS) {
      lastTriggeredAt.set(profile, Date.now());
      after(() =>
        topUpExamPool(profile, { timeBudgetMs: TOPUP_HOOK_TIME_BUDGET_MS }).catch((e) =>
          logError("exam-topup-hook", e, { profile }),
        ),
      );
    }

    if (!current) {
      // 新しい回を開始できるかどうか（1日1回制限）。既に進行中の回がある場合は
      // その回のパートを続けるだけなので、この制限は「新規開始」の場合のみ関わる
      return NextResponse.json({ hasInProgress: false, remainingThisMonth, commonReady, specializedReady, canStartNewRound: !startedToday });
    }
    return NextResponse.json({
      hasInProgress: true,
      examAttemptId: current.id,
      commonStatus: current.common_status,
      specializedStatus: current.specialized_status,
      remainingThisMonth,
      commonReady,
      specializedReady,
      canStartNewRound: !startedToday,
    });
  } catch (e) {
    await logError("exam-state", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
