import { supabase } from "./supabase";

export type WrongStockEntry = { subject: string; missCount: number };

// 「1回正解しただけで復習ストックから外れる」のは定着の証明として弱いため、
// 直近3回連続で正解して初めて弱点を克服したとみなす（1回でも間違えれば
// 連続カウントは振り出しに戻り、即座にストックへ戻る）。
const REQUIRED_STREAK = 3;

type QuestionStat = { subject: string; missCount: number; trailingCorrect: number };

async function computeQuestionStats(): Promise<Map<number, QuestionStat>> {
  const sb = supabase();
  const { data: attempts, error } = await sb
    .from("attempts")
    .select("question_id, is_correct, answered_at, questions!inner(subject)")
    .eq("profile", "self")
    .order("answered_at", { ascending: true });
  if (error) throw new Error(error.message);

  type Row = { question_id: number; is_correct: boolean; questions: { subject: string } | null };
  const byQuestion = new Map<number, { subject: string; history: boolean[] }>();
  for (const a of (attempts ?? []) as unknown as Row[]) {
    const subject = a.questions?.subject;
    if (!subject) continue;
    const entry = byQuestion.get(a.question_id) ?? { subject, history: [] };
    entry.history.push(a.is_correct);
    byQuestion.set(a.question_id, entry);
  }

  const stats = new Map<number, QuestionStat>();
  for (const [questionId, { subject, history }] of byQuestion) {
    const missCount = history.filter((ok) => !ok).length;
    let trailingCorrect = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]) trailingCorrect++;
      else break;
    }
    stats.set(questionId, { subject, missCount, trailingCorrect });
  }
  return stats;
}

/**
 * 本人(profile='self')の全解答履歴から、「一度でも間違えたことがあり、かつ直近の
 * 連続正解数がREQUIRED_STREAK未満」の問題を弱点ストックとして返す。missCountは
 * 過去の誤答回数の合計で、復習出題の重み付き抽選にそのまま使う値。
 * 一度も間違えていない問題はそもそもストック対象外（元々弱点ではないため）。
 */
export async function computeWrongStock(): Promise<Map<number, WrongStockEntry>> {
  const stats = await computeQuestionStats();
  const result = new Map<number, WrongStockEntry>();
  for (const [questionId, { subject, missCount, trailingCorrect }] of stats) {
    if (missCount === 0 || trailingCorrect >= REQUIRED_STREAK) continue;
    result.set(questionId, { subject, missCount });
  }
  return result;
}

/**
 * ホーム画面の「弱点ゼロまで」進捗リング用。一度でも間違えたことがある問題の総数
 * (everMissed)と、そのうち今も弱点ストックに残っている数(currentWrong)を返す。
 * 消化率 = (everMissed - currentWrong) / everMissed で「これまで間違えた問題のうち
 * 克服できた割合」を表す（everMissedが増え続ける指標のため、0%からではなく
 * 常に今の到達度を示す）。
 */
export async function getWrongStockProgress(): Promise<{ everMissed: number; currentWrong: number }> {
  const stats = await computeQuestionStats();
  let everMissed = 0;
  let currentWrong = 0;
  for (const { missCount, trailingCorrect } of stats.values()) {
    if (missCount === 0) continue;
    everMissed++;
    if (trailingCorrect < REQUIRED_STREAK) currentWrong++;
  }
  return { everMissed, currentWrong };
}

/** getWrongStockProgressの科目別版。復習モードの科目選択画面で「あと何問でクリアか」を科目ごとに出すために使う。 */
export async function getWrongStockProgressBySubject(): Promise<Map<string, { everMissed: number; currentWrong: number }>> {
  const stats = await computeQuestionStats();
  const bySubject = new Map<string, { everMissed: number; currentWrong: number }>();
  for (const { subject, missCount, trailingCorrect } of stats.values()) {
    if (missCount === 0) continue;
    const entry = bySubject.get(subject) ?? { everMissed: 0, currentWrong: 0 };
    entry.everMissed++;
    if (trailingCorrect < REQUIRED_STREAK) entry.currentWrong++;
    bySubject.set(subject, entry);
  }
  return bySubject;
}
