import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { computePartResult, computeVerdict, ExamAttemptRow } from "@/lib/examMode";
import { ExamPart } from "@/lib/examFormat";

/**
 * 指定パートを完了扱いにする（全問回答済み、またはタイマー切れの両方から呼ばれる）。
 * 未回答の設問は不正解として合成attemptsを挿入してから完了にする（時間切れ＝不正解方針）。
 * 両パートが揃った時点で合否判定（科目群ごとの0点チェック＋総得点率60%）を計算して返す。
 */
export async function POST(req: NextRequest) {
  try {
    const { examAttemptId, part } = (await req.json()) as { examAttemptId?: number; part?: ExamPart };
    if (!examAttemptId || (part !== "common" && part !== "specialized")) {
      return NextResponse.json({ error: "examAttemptId, part are required" }, { status: 400 });
    }
    const sb = supabase();
    const { data: row, error } = await sb.from("exam_attempts").select("*").eq("id", examAttemptId).single();
    if (error || !row) return NextResponse.json({ error: "exam attempt not found" }, { status: 404 });
    const typedRow = row as ExamAttemptRow;

    const isCommon = part === "common";
    const currentStatus = isCommon ? typedRow.common_status : typedRow.specialized_status;
    const questionIds = (isCommon ? typedRow.common_question_ids : typedRow.specialized_question_ids) ?? [];

    if (currentStatus !== "completed") {
      const { data: answeredRows } = await sb
        .from("attempts")
        .select("question_id")
        .eq("exam_attempt_id", examAttemptId)
        .in("question_id", questionIds);
      const answeredIds = new Set((answeredRows ?? []).map((r) => r.question_id as number));
      const unanswered = questionIds.filter((id) => !answeredIds.has(id));
      if (unanswered.length > 0) {
        // クライアント入力を信用せず、この回自体のprofile（exam_attempts行）から導出する。
        // ここを誤ると集計ビュー（exam_subject_stats）への振り分けが静かに壊れるため重要。
        const { error: insError } = await sb.from("attempts").insert(
          unanswered.map((question_id) => ({
            question_id,
            selected: [],
            is_correct: false,
            mode: "exam",
            profile: typedRow.profile,
            exam_attempt_id: examAttemptId,
          })),
        );
        if (insError) throw new Error(insError.message);
      }
      const nowIso = new Date().toISOString();
      const patch = isCommon
        ? { common_status: "completed" as const, common_completed_at: nowIso }
        : { specialized_status: "completed" as const, specialized_completed_at: nowIso };
      const { error: updateError } = await sb.from("exam_attempts").update(patch).eq("id", examAttemptId);
      if (updateError) throw new Error(updateError.message);
    }

    const { data: updatedRow } = await sb.from("exam_attempts").select("*").eq("id", examAttemptId).single();
    const updated = updatedRow as ExamAttemptRow;
    const bothDone = updated.common_status === "completed" && updated.specialized_status === "completed";

    const partResult = await computePartResult(examAttemptId, questionIds);

    let verdict = null;
    if (bothDone) {
      const [commonResult, specializedResult] = await Promise.all([
        computePartResult(examAttemptId, updated.common_question_ids ?? []),
        computePartResult(examAttemptId, updated.specialized_question_ids ?? []),
      ]);
      verdict = computeVerdict([...commonResult.bySubject, ...specializedResult.bySubject]);
    }

    return NextResponse.json({ part, partResult, bothDone, verdict });
  } catch (e) {
    await logError("exam-finish", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
