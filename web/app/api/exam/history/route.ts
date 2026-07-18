import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { computePartResult, computeVerdict, ExamAttemptRow } from "@/lib/examMode";

/** 完了済み回（両パート完了）の一覧。得点率・合否・日時。成績タブ・full-mockページ両方で使う。 */
export async function GET() {
  try {
    const sb = supabase();
    const { data: rows, error } = await sb
      .from("exam_attempts")
      .select("*")
      .eq("profile", "self")
      .eq("common_status", "completed")
      .eq("specialized_status", "completed")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const history = await Promise.all(
      ((rows ?? []) as ExamAttemptRow[]).map(async (row) => {
        const [commonResult, specializedResult] = await Promise.all([
          computePartResult(row.id, row.common_question_ids ?? []),
          computePartResult(row.id, row.specialized_question_ids ?? []),
        ]);
        const bySubject = [...commonResult.bySubject, ...specializedResult.bySubject];
        const verdict = computeVerdict(bySubject);
        const commonAt = row.common_completed_at ? new Date(row.common_completed_at).getTime() : 0;
        const specializedAt = row.specialized_completed_at ? new Date(row.specialized_completed_at).getTime() : 0;
        const completedAt = new Date(Math.max(commonAt, specializedAt)).toISOString();
        return { examAttemptId: row.id, completedAt, verdict, bySubject };
      }),
    );
    return NextResponse.json({ history });
  } catch (e) {
    await logError("exam-history", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
