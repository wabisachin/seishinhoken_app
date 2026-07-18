import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/**
 * 復習モードの科目選択画面用。科目ごとに「最新解答が誤答のままの問題数」を返す。
 * これが多い科目ほど苦手科目とみなし、選択画面で視覚的に目立たせる材料にする。
 */
export async function GET() {
  try {
    const sb = supabase();
    const { data: attempts, error } = await sb
      .from("attempts")
      .select("question_id, is_correct, answered_at, questions!inner(subject)")
      .eq("profile", "self")
      .order("answered_at", { ascending: false });
    if (error) throw new Error(error.message);

    const latest = new Map<number, { ok: boolean; subject: string }>();
    for (const a of attempts ?? []) {
      if (latest.has(a.question_id)) continue;
      const subject = (a.questions as unknown as { subject: string } | null)?.subject;
      if (!subject) continue;
      latest.set(a.question_id, { ok: a.is_correct as boolean, subject });
    }

    const wrongCountBySubject = new Map<string, number>();
    let totalWrong = 0;
    for (const { ok, subject } of latest.values()) {
      if (ok) continue;
      wrongCountBySubject.set(subject, (wrongCountBySubject.get(subject) ?? 0) + 1);
      totalWrong++;
    }

    const subjects = [...wrongCountBySubject.entries()]
      .map(([subject, wrongCount]) => ({ subject, wrongCount }))
      .sort((a, b) => b.wrongCount - a.wrongCount);

    return NextResponse.json({ subjects, totalWrong });
  } catch (e) {
    await logError("review-summary", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
