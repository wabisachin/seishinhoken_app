import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { computePartResult, computeVerdict, ExamAttemptRow } from "@/lib/examMode";
import { isValidProfile } from "@/lib/profile";

/**
 * 完了済み回（両パート完了）の一覧。得点率・合否・日時。成績タブ・full-mockページ両方で使う。
 * profileは必須クエリパラメータ ── 呼び出し元がexam/history?profile=self（応援する人は常にこれ）
 * または動作テスト用のアクティブprofileを明示的に指定する。
 */
export async function GET(req: NextRequest) {
  try {
    const profile = req.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const sb = supabase();
    const { data: rows, error } = await sb
      .from("exam_attempts")
      .select("*")
      .eq("profile", profile)
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
