import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import {
  getCurrentExamAttempt,
  reserveQuestionsForPart,
  countRoundsThisMonth,
  hasStartedRoundToday,
  ExamAttemptRow,
} from "@/lib/examMode";
import { EXAM_MONTHLY_LIMIT, EXAM_TIME_LIMIT_SECONDS, ExamPart } from "@/lib/examFormat";
import { topUpExamPool } from "@/lib/questionSupply";
import { isValidProfile } from "@/lib/profile";

// 実戦模試プール不足時にafter()でtopUpExamPoolを走らせる場合に備え、通常のtopupフックと
// 同じ考え方でmaxDurationを確保する。
export const maxDuration = 300;
const TOPUP_HOOK_TIME_BUDGET_MS = 270_000;

/**
 * 実戦模試の指定パート（午前=common/午後=specialized）を開始する。
 * 進行中の回が無ければ月次上限チェック後に新規exam_attempts行を作成し、
 * あれば既存の回に対して未着手のパートを開始する（両パートは独立したタイミングで受験できる）。
 */
export async function POST(req: NextRequest) {
  try {
    const { part, profile } = (await req.json()) as { part?: ExamPart; profile?: string };
    if (part !== "common" && part !== "specialized") {
      return NextResponse.json({ error: "part must be 'common' or 'specialized'" }, { status: 400 });
    }
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const sb = supabase();
    const isCommon = part === "common";
    let current: ExamAttemptRow | null = await getCurrentExamAttempt(profile);

    if (current) {
      const status = isCommon ? current.common_status : current.specialized_status;
      if (status === "completed") {
        return NextResponse.json({ error: "このパートは既に完了しています" }, { status: 400 });
      }
      if (status === "in_progress") {
        const questionIds = (isCommon ? current.common_question_ids : current.specialized_question_ids) ?? [];
        return NextResponse.json({
          ready: true,
          examAttemptId: current.id,
          part,
          questionIds,
          remainingSeconds: EXAM_TIME_LIMIT_SECONDS[part],
        });
      }
      // not_started ならこの回でこのパートを開始する（下に続く）
    } else {
      // 受験回数の月次・日次制限は本人・動作テスト用で同一のロジックをそのまま適用する
      // （特別扱いしない。本人確認済みの方針）。
      const roundsThisMonth = await countRoundsThisMonth(profile);
      if (roundsThisMonth >= EXAM_MONTHLY_LIMIT) {
        return NextResponse.json({ error: "今月の受験回数の上限に達しています" }, { status: 400 });
      }
      // 実力測定として意味を持たせるため、新しい回の開始は1日1回までに制限する
      // （既に開始済みの回で残りのパートを受ける分には制限しない）
      if (await hasStartedRoundToday(profile)) {
        return NextResponse.json(
          { error: "実戦模試は1日1回までです。今日開始した回は既にあります。日をまたぐとまた新しい回を始められます" },
          { status: 400 },
        );
      }
      const { data: inserted, error } = await sb.from("exam_attempts").insert({ profile }).select("*").single();
      if (error) throw new Error(error.message);
      current = inserted as ExamAttemptRow;
    }

    const questionIds = await reserveQuestionsForPart(part, profile);
    if (!questionIds) {
      after(() =>
        topUpExamPool(profile, { timeBudgetMs: TOPUP_HOOK_TIME_BUDGET_MS }).catch((e) =>
          logError("exam-topup-hook", e, { profile }),
        ),
      );
      return NextResponse.json({ ready: false, message: "問題を準備中です。しばらくしてからもう一度お試しください。" });
    }

    const nowIso = new Date().toISOString();
    const patch = isCommon
      ? { common_status: "in_progress" as const, common_question_ids: questionIds, common_started_at: nowIso }
      : { specialized_status: "in_progress" as const, specialized_question_ids: questionIds, specialized_started_at: nowIso };
    const { error: updateError } = await sb.from("exam_attempts").update(patch).eq("id", current.id);
    if (updateError) throw new Error(updateError.message);

    // 消費した分（このパートぶんの出題）を即座に補充する（科目別演習の出題直後フックと
    // 同じ考え方。日次cron任せだと最大1日ストックが目標を下回ったままになるため）。
    // 実際に消費したprofile自身のプールを補充する。
    after(() =>
      topUpExamPool(profile, { timeBudgetMs: TOPUP_HOOK_TIME_BUDGET_MS }).catch((e) =>
        logError("exam-topup-hook", e, { profile }),
      ),
    );

    return NextResponse.json({
      ready: true,
      examAttemptId: current.id,
      part,
      questionIds,
      remainingSeconds: EXAM_TIME_LIMIT_SECONDS[part],
    });
  } catch (e) {
    await logError("exam-start", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
