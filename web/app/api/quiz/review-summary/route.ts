import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { getWrongStockProgress, getWrongStockProgressBySubject } from "@/lib/reviewStock";
import { listSubjects } from "@/lib/subjects";
import { getStockSnapshot, SUBJECT_TARGET } from "@/lib/questionSupply";
import { isValidProfile } from "@/lib/profile";

/**
 * 復習モードの科目選択画面・ホーム画面の弱点マップ用。全科目（過去問+タクソノミーの
 * 和集合）を対象に、科目ごとの解答数・弱点ストック件数・出題プールが上限
 * （SUBJECT_TARGET問）まで生成し切っているかを返す。呼び出し側で用途に応じてフィルタする
 * （復習モードの選択肢は wrongCount > 0 の科目だけに絞る。ホーム画面の弱点マップは
 * 克服済み科目も含めて全科目を表示する）。
 * 苦手科目の判定は正答率ではなく「間違えたまま残っている問題の総数」で行う
 * （このアプリの学習ゴールは、一度間違えた問題を同一問題で3回連続正解させて
 * 克服することであり、正答率という統計量で評価するものではないため）。
 */
export async function GET(req: NextRequest) {
  try {
    const profile = req.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });

    const [{ data: attempts, error }, allSubjects, stockSnapshot] = await Promise.all([
      supabase().from("attempts").select("question_id, questions!inner(subject)").eq("profile", profile),
      listSubjects(),
      getStockSnapshot(profile),
    ]);
    if (error) throw new Error(error.message);

    // 弱点ストック（今も間違えたまま残っている問題数）は、一度でも間違えたことがあり
    // 直近3問連続正解で卒業していない問題の数。これは全期間で見る（間違えた問題は
    // 解き直して正解するまでずっとストックに残るのがこのアプリの学習ゴールであり、
    // 直近何件かで判定するものではない）
    const [progress, progressBySubject] = await Promise.all([
      getWrongStockProgress(profile),
      getWrongStockProgressBySubject(profile),
    ]);
    const totalWrong = progress.currentWrong;

    // 解答数は「これまでに出題された、重複の無い問題の数」（窓で区切らない全期間）。
    // attemptsの行数をそのまま数えると、復習モードで同じ問題を3問連続正解するまで
    // 何度も解き直した分だけ水増しされてしまい、「どれだけの問題数に触れたか」という
    // 本来知りたい指標とズレるため、question_idの重複を除いてから数える
    const questionIdsBySubject = new Map<string, Set<number>>();
    for (const a of attempts ?? []) {
      const subject = (a.questions as unknown as { subject: string } | null)?.subject;
      if (!subject) continue;
      const set = questionIdsBySubject.get(subject) ?? new Set<number>();
      set.add(a.question_id as number);
      questionIdsBySubject.set(subject, set);
    }
    const totalBySubject = new Map<string, number>([...questionIdsBySubject.entries()].map(([s, set]) => [s, set.size]));
    const activeBySubject = new Map(stockSnapshot.map((s) => [s.subject, s.active]));

    const subjects = allSubjects
      .map((subject) => {
        const total = totalBySubject.get(subject) ?? 0;
        const subjectProgress = progressBySubject.get(subject) ?? { everMissed: 0, currentWrong: 0 };
        return {
          subject,
          total,
          wrongCount: subjectProgress.currentWrong,
          everMissed: subjectProgress.everMissed,
          // 出題プールがSUBJECT_TARGET問まで生成し切っている（＝この科目で今後
          // 新しい問題が増える余地がほぼ無い）かどうか。wrongCount=0と組み合わせて
          // 「この科目は完全制覇した」の判定に使う
          poolFull: (activeBySubject.get(subject) ?? 0) >= SUBJECT_TARGET,
        };
      })
      .sort((a, b) => {
        const aNeedsReview = a.wrongCount > 0;
        const bNeedsReview = b.wrongCount > 0;
        if (aNeedsReview !== bNeedsReview) return aNeedsReview ? -1 : 1;
        if (aNeedsReview) return b.wrongCount - a.wrongCount;
        return a.total - b.total;
      });

    return NextResponse.json({ subjects, totalWrong, everMissed: progress.everMissed });
  } catch (e) {
    await logError("review-summary", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
