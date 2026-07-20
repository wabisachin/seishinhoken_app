import { supabase } from "./supabase";

export type WrongStockEntry = { subject: string; missCount: number };

// 直近の解答が正解なら弱点を克服したとみなす（1回でも間違えれば即座にストックへ戻る）。
// 以前は3回連続正解を要求していたが、復習ストックが積み上がりすぎてテンポが悪くなる
// ほうが問題であり、克服後に忘れていないかは想起の庭（GARDEN_OVERCOME_MIN_DAYS）で
// 別途確認できるため、1回正解で即座に克服扱いにする方針に変更した。
const REQUIRED_STREAK = 1;

// 想起の庭（克服済みだが忘れかけている問題の再出題）関連の定数。
// 克服してからこの日数以上経過した問題だけが対象になる（忘却曲線を踏まえ、
// ある程度時間が経ってから記憶の定着を確認する）。1回正解するとすぐ克服扱いになる分、
// 想起の庭側の再確認サイクルは短め(2週間)にして、忘れたまま長期間放置されないようにする。
export const GARDEN_OVERCOME_MIN_DAYS = 14;
// 対象問題がこの件数に満たない場合はUIでグレーアウトする（毎回同じ数問を
// 繰り返し出題するだけになってしまうのを避けるための最低ライン）。
export const GARDEN_MIN_ELIGIBLE = 30;

type QuestionStat = {
  subject: string;
  missCount: number;
  trailingCorrect: number;
  /** 直近の正解のanswered_at。現在克服済み(trailingCorrect>=REQUIRED_STREAK)の場合のみ値を持つ。 */
  overcomeAt: string | null;
};

async function computeQuestionStats(profile: string): Promise<Map<number, QuestionStat>> {
  const sb = supabase();
  const { data: attempts, error } = await sb
    .from("attempts")
    .select("question_id, is_correct, answered_at, questions!inner(subject)")
    .eq("profile", profile)
    .order("answered_at", { ascending: true });
  if (error) throw new Error(error.message);

  type Row = { question_id: number; is_correct: boolean; answered_at: string; questions: { subject: string } | null };
  const byQuestion = new Map<number, { subject: string; history: { is_correct: boolean; answered_at: string }[] }>();
  for (const a of (attempts ?? []) as unknown as Row[]) {
    const subject = a.questions?.subject;
    if (!subject) continue;
    const entry = byQuestion.get(a.question_id) ?? { subject, history: [] };
    entry.history.push({ is_correct: a.is_correct, answered_at: a.answered_at });
    byQuestion.set(a.question_id, entry);
  }

  const stats = new Map<number, QuestionStat>();
  for (const [questionId, { subject, history }] of byQuestion) {
    const missCount = history.filter((h) => !h.is_correct).length;
    let trailingCorrect = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].is_correct) trailingCorrect++;
      else break;
    }
    // 克服の瞬間 = 直近の正解のanswered_at。想起の庭で再テストして正解した場合も
    // ここが更新されることで、そこから改めてGARDEN_OVERCOME_MIN_DAYS日のカウントダウンが
    // 始まる（更新されないと、一度対象になった問題が正解し続けても「経過日数」が
    // 伸び続けてしまい、想起の庭でずっと最優先で出続けてしまう）。
    const overcomeAt = trailingCorrect >= REQUIRED_STREAK ? history[history.length - 1].answered_at : null;
    stats.set(questionId, { subject, missCount, trailingCorrect, overcomeAt });
  }
  return stats;
}

/**
 * 指定profileの全解答履歴から、「一度でも間違えたことがあり、かつ直近の
 * 連続正解数がREQUIRED_STREAK未満」の問題を弱点ストックとして返す。missCountは
 * 過去の誤答回数の合計で、復習出題の重み付き抽選にそのまま使う値。
 * 一度も間違えていない問題はそもそもストック対象外（元々弱点ではないため）。
 * profileは必須引数。
 */
export async function computeWrongStock(profile: string): Promise<Map<number, WrongStockEntry>> {
  const stats = await computeQuestionStats(profile);
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
export async function getWrongStockProgress(profile: string): Promise<{ everMissed: number; currentWrong: number }> {
  const stats = await computeQuestionStats(profile);
  let everMissed = 0;
  let currentWrong = 0;
  for (const { missCount, trailingCorrect } of stats.values()) {
    if (missCount === 0) continue;
    everMissed++;
    if (trailingCorrect < REQUIRED_STREAK) currentWrong++;
  }
  return { everMissed, currentWrong };
}

/**
 * 一度でも間違えたことがある問題のID一覧（現在克服済みかどうかは問わない。科目付き）。
 * 月間プランの復習セット進捗判定用: 「今は克服済みで現在の弱点ストックには無いが、
 * 今月中に正解して克服した」問題も復習の実績としてカウントしたいため、現在進行形の
 * 弱点ストック(computeWrongStock)ではなく、全履歴を通じて一度でも間違えたことが
 * あるかどうかで判定する。
 */
export async function getEverMissedQuestionIds(profile: string): Promise<Map<number, string>> {
  const stats = await computeQuestionStats(profile);
  const result = new Map<number, string>();
  for (const [questionId, { subject, missCount }] of stats) {
    if (missCount > 0) result.set(questionId, subject);
  }
  return result;
}

/** getWrongStockProgressの科目別版。復習モードの科目選択画面で「あと何問でクリアか」を科目ごとに出すために使う。 */
export async function getWrongStockProgressBySubject(
  profile: string,
): Promise<Map<string, { everMissed: number; currentWrong: number }>> {
  const stats = await computeQuestionStats(profile);
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

export type GardenEntry = { subject: string; missCount: number; overcomeAt: string; daysSinceOvercome: number };

/**
 * 想起の庭（克服済みだが忘れかけている問題）の対象一覧。「今も克服済み
 * (trailingCorrect>=REQUIRED_STREAK)」かつ「克服してからGARDEN_OVERCOME_MIN_DAYS日以上
 * 経過」した問題を返す。想起の庭で誤答すればtrailingCorrectがリセットされ弱点ストックに
 * 戻る（＝この一覧からも自動的に外れる）ため、克服状態を保つための追加のカラムや
 * 状態管理は不要 ── computeQuestionStats の履歴走査だけで完結する。
 */
export async function computeGardenEligible(profile: string): Promise<Map<number, GardenEntry>> {
  const stats = await computeQuestionStats(profile);
  const now = Date.now();
  const result = new Map<number, GardenEntry>();
  for (const [questionId, { subject, missCount, trailingCorrect, overcomeAt }] of stats) {
    // 一度も間違えたことが無い問題（＝そもそも弱点ではなかった問題）は対象外。
    // REQUIRED_STREAKが3だった頃はtrailingCorrect>=3にほぼ自然に絞られていたため
    // 暗黙のガードで足りていたが、1になった今は「直近の解答が正解」なだけの
    // 大多数の問題まで含んでしまうため、明示的にmissCount>0を要求する
    if (missCount === 0 || trailingCorrect < REQUIRED_STREAK || !overcomeAt) continue;
    const daysSinceOvercome = Math.floor((now - new Date(overcomeAt).getTime()) / 86_400_000);
    if (daysSinceOvercome < GARDEN_OVERCOME_MIN_DAYS) continue;
    result.set(questionId, { subject, missCount, overcomeAt, daysSinceOvercome });
  }
  return result;
}

/** 想起の庭の選択画面用。対象件数と前回実施日（mode='garden'の最新answered_at）。 */
export async function getGardenSummary(profile: string): Promise<{ eligibleCount: number; lastPlayedAt: string | null }> {
  const [eligible, { data: lastRow }] = await Promise.all([
    computeGardenEligible(profile),
    supabase()
      .from("attempts")
      .select("answered_at")
      .eq("profile", profile)
      .eq("mode", "garden")
      .order("answered_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return { eligibleCount: eligible.size, lastPlayedAt: (lastRow?.answered_at as string | undefined) ?? null };
}
