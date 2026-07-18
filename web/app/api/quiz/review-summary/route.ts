import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { getWrongStockProgress, getWrongStockProgressBySubject } from "@/lib/reviewStock";
import { listSubjects } from "@/lib/subjects";

// 苦手科目の「今の」優先度を測る窓。数ヶ月前に苦手だった科目がその後克服されても
// 全期間累積だと正答率が低いまま表示され続け、逆に最近伸び悩んでいる科目が過去の
// 貯金で高く出てしまう問題を避けるため、直近N件の解答だけで正答率を判定する
// （弱点ストック＝復習対象の問題数そのものは、後述の通り全期間で判定して別に保持する）。
const RECENT_WINDOW = 30;

/**
 * 復習モードの科目選択画面・ホーム画面の弱点マップ用。全科目（過去問+タクソノミーの
 * 和集合）を対象に、科目ごとの正答率（直近RECENT_WINDOW件の解答ベース）と弱点ストック
 * 件数を返す。呼び出し側で用途に応じてフィルタする（復習モードの選択肢は
 * wrongCount > 0 の科目だけに絞る。ホーム画面の弱点マップは克服済み科目も含めて
 * 全科目を表示する）。
 * 苦手科目の判定は間違えた問題数の絶対数ではなく正答率で行うのが正確なため
 * （出題数が多い科目ほど間違えた問題数も単純に多くなりがちなことへの対策）。
 * 併せて「何問中何問正解」も返し、率だけでなく実数もユーザーに分かるようにする。
 */
export async function GET() {
  try {
    const sb = supabase();
    const [{ data: attempts, error }, allSubjects] = await Promise.all([
      sb
        .from("attempts")
        .select("question_id, is_correct, answered_at, questions!inner(subject)")
        .eq("profile", "self")
        .order("answered_at", { ascending: false }),
      listSubjects(),
    ]);
    if (error) throw new Error(error.message);

    // 弱点ストック（今も間違えたまま残っている問題数）は、一度でも間違えたことがあり
    // 直近3問連続正解で卒業していない問題の数。これは全期間で見る（間違えた問題は
    // 解き直して正解するまでずっとストックに残るのがこのアプリの学習ゴールであり、
    // 直近何件かで判定するものではない）
    const [progress, progressBySubject] = await Promise.all([getWrongStockProgress(), getWrongStockProgressBySubject()]);
    const totalWrong = progress.currentWrong;

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

    const subjects = allSubjects
      .map((subject) => {
        const recent = recentBySubject.get(subject) ?? [];
        const correct = recent.filter(Boolean).length;
        const total = recent.length;
        const subjectProgress = progressBySubject.get(subject) ?? { everMissed: 0, currentWrong: 0 };
        return {
          subject,
          correct,
          total,
          wrongCount: subjectProgress.currentWrong,
          everMissed: subjectProgress.everMissed,
          // まだ一度も解いていない科目はnull（0%と紛らわしいため区別する）
          accuracy: total > 0 ? Math.round((100 * correct) / total) : null,
        };
      })
      .sort((a, b) => {
        const aNeedsReview = a.wrongCount > 0;
        const bNeedsReview = b.wrongCount > 0;
        if (aNeedsReview !== bNeedsReview) return aNeedsReview ? -1 : 1;
        return (a.accuracy ?? 100) - (b.accuracy ?? 100);
      });

    return NextResponse.json({ subjects, totalWrong, everMissed: progress.everMissed });
  } catch (e) {
    await logError("review-summary", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
