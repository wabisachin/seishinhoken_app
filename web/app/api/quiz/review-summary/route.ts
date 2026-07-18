import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/**
 * 復習モードの科目選択画面用。科目ごとに正答率（最新解答ベース）を返す。
 * 苦手科目の判定は間違えた問題数の絶対数ではなく正答率で行うのが正確なため
 * （出題数が多い科目ほど間違えた問題数も単純に多くなりがちなことへの対策）。
 * 併せて「何問中何問正解」も返し、率だけでなく実数もユーザーに分かるようにする。
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

    const bySubject = new Map<string, { correct: number; total: number }>();
    let totalWrong = 0;
    for (const { ok, subject } of latest.values()) {
      const s = bySubject.get(subject) ?? { correct: 0, total: 0 };
      s.total++;
      if (ok) s.correct++;
      else totalWrong++;
      bySubject.set(subject, s);
    }

    const subjects = [...bySubject.entries()]
      .map(([subject, s]) => ({
        subject,
        correct: s.correct,
        total: s.total,
        wrongCount: s.total - s.correct,
        accuracy: Math.round((100 * s.correct) / Math.max(s.total, 1)),
      }))
      .filter((s) => s.wrongCount > 0) // 復習対象が無い科目は選択肢に出す意味が無い
      .sort((a, b) => a.accuracy - b.accuracy);

    return NextResponse.json({ subjects, totalWrong });
  } catch (e) {
    await logError("review-summary", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
