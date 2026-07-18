import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

// 苦手科目の「今の」優先度を測る窓。数ヶ月前に苦手だった科目がその後克服されても
// 全期間累積だと正答率が低いまま表示され続け、逆に最近伸び悩んでいる科目が過去の
// 貯金で高く出てしまう問題を避けるため、直近N件の解答だけで正答率を判定する
// （弱点ストック＝復習対象の問題数そのものは、後述の通り全期間で判定して別に保持する）。
const RECENT_WINDOW = 30;

/**
 * 復習モードの科目選択画面用。科目ごとに正答率（直近RECENT_WINDOW件の解答ベース）を返す。
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

    // 弱点ストック（今も間違えたまま残っている問題数）は問題ごとの最新解答で判定する。
    // これは全期間で見る（間違えた問題は解き直して正解するまでずっとストックに残るのが
    // このアプリの学習ゴールであり、直近何件かで判定するものではない）
    const latestByQuestion = new Map<number, { ok: boolean; subject: string }>();
    for (const a of attempts ?? []) {
      if (latestByQuestion.has(a.question_id)) continue;
      const subject = (a.questions as unknown as { subject: string } | null)?.subject;
      if (!subject) continue;
      latestByQuestion.set(a.question_id, { ok: a.is_correct as boolean, subject });
    }
    const wrongCountBySubject = new Map<string, number>();
    let totalWrong = 0;
    for (const { ok, subject } of latestByQuestion.values()) {
      if (!ok) {
        wrongCountBySubject.set(subject, (wrongCountBySubject.get(subject) ?? 0) + 1);
        totalWrong++;
      }
    }

    // 一方、「今どの科目を優先すべきか」の正答率ランキングは直近RECENT_WINDOW件のみで見る
    const recentBySubject = new Map<string, boolean[]>();
    for (const a of attempts ?? []) {
      const subject = (a.questions as unknown as { subject: string } | null)?.subject;
      if (!subject) continue;
      const recent = recentBySubject.get(subject) ?? [];
      if (recent.length < RECENT_WINDOW) {
        recent.push(a.is_correct as boolean);
        recentBySubject.set(subject, recent);
      }
    }

    const subjects = [...recentBySubject.entries()]
      .map(([subject, recent]) => {
        const correct = recent.filter(Boolean).length;
        const total = recent.length;
        return {
          subject,
          correct,
          total,
          wrongCount: wrongCountBySubject.get(subject) ?? 0,
          accuracy: Math.round((100 * correct) / Math.max(total, 1)),
        };
      })
      .filter((s) => s.wrongCount > 0) // 復習対象が無い科目は選択肢に出す意味が無い
      .sort((a, b) => a.accuracy - b.accuracy);

    return NextResponse.json({ subjects, totalWrong });
  } catch (e) {
    await logError("review-summary", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
