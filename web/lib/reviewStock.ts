import { supabase } from "./supabase";

export type WrongStockEntry = { subject: string; missCount: number };

// 「1回正解しただけで復習ストックから外れる」のは定着の証明として弱いため、
// 直近3回連続で正解して初めて弱点を克服したとみなす（1回でも間違えれば
// 連続カウントは振り出しに戻り、即座にストックへ戻る）。
const REQUIRED_STREAK = 3;

/**
 * 本人(profile='self')の全解答履歴から、「一度でも間違えたことがあり、かつ直近の
 * 連続正解数がREQUIRED_STREAK未満」の問題を弱点ストックとして返す。missCountは
 * 過去の誤答回数の合計で、復習出題の重み付き抽選にそのまま使う値。
 * 一度も間違えていない問題はそもそもストック対象外（元々弱点ではないため）。
 */
export async function computeWrongStock(): Promise<Map<number, WrongStockEntry>> {
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

  const result = new Map<number, WrongStockEntry>();
  for (const [questionId, { subject, history }] of byQuestion) {
    const missCount = history.filter((ok) => !ok).length;
    if (missCount === 0) continue;
    let trailingCorrect = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]) trailingCorrect++;
      else break;
    }
    if (trailingCorrect >= REQUIRED_STREAK) continue;
    result.set(questionId, { subject, missCount });
  }
  return result;
}
