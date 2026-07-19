import { supabase } from "./supabase";
import { EXAM_PASS_SCORE_RATE, EXAM_SUBJECT_GROUPS, ExamPart, subjectsForPart } from "./examFormat";

export type ExamStatus = "not_started" | "in_progress" | "completed";

export type ExamAttemptRow = {
  id: number;
  profile: string;
  common_status: ExamStatus;
  specialized_status: ExamStatus;
  common_question_ids: number[] | null;
  specialized_question_ids: number[] | null;
  common_started_at: string | null;
  common_completed_at: string | null;
  specialized_started_at: string | null;
  specialized_completed_at: string | null;
  created_at: string;
};

/**
 * 進行中（両パートがまだ揃って完了していない）の回を1つ返す。このアプリは常に
 * 「前の回が完了するまで次の回を開始できない」運用なので、profileごとに高々1件しか
 * 該当しない前提（created_at最新の1件を見れば足りる）。
 * profileは必須引数（デフォルト値を持たせない ── 呼び出し元にスコープを毎回明示させ、
 * つけ忘れをコンパイルエラーに変えるため）。
 */
export async function getCurrentExamAttempt(profile: string): Promise<ExamAttemptRow | null> {
  const sb = supabase();
  const { data, error } = await sb
    .from("exam_attempts")
    .select("*")
    .eq("profile", profile)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as ExamAttemptRow | undefined;
  if (!row) return null;
  if (row.common_status === "completed" && row.specialized_status === "completed") return null;
  return row;
}

/** 暦月でリセットする月次上限用のカウント（既存/api/statsと同じ「文字列の年月比較」方式でタイムゾーンのずれを避ける）。profileは必須引数。 */
export async function countRoundsThisMonth(profile: string): Promise<number> {
  const sb = supabase();
  const { data, error } = await sb.from("exam_attempts").select("created_at").eq("profile", profile);
  if (error) throw new Error(error.message);
  const thisMonth = new Date().toISOString().slice(0, 7);
  return (data ?? []).filter((r) => String(r.created_at).slice(0, 7) === thisMonth).length;
}

/**
 * 実戦模試は一日に何度も受けても実力測定として意味が無いため、新しい回(exam_attempts)を
 * 開始できるのは1日1回までに制限する（月5回の上限とは別軸のガード）。日付比較は
 * countRoundsThisMonthと同じ「文字列の年月日比較」方式でタイムゾーンのずれを避ける。
 * profileは必須引数。
 */
export async function hasStartedRoundToday(profile: string): Promise<boolean> {
  const sb = supabase();
  const { data, error } = await sb.from("exam_attempts").select("created_at").eq("profile", profile);
  if (error) throw new Error(error.message);
  const today = new Date().toISOString().slice(0, 10);
  return (data ?? []).some((r) => String(r.created_at).slice(0, 10) === today);
}

/**
 * 指定パートの出題を実戦模試専用ストック（pool='exam', status='active'）から科目ごとの
 * 本番出題数だけ確保し、即座にpool='general'へ更新する（=消費・通常プールへの合流を予約時点で
 * 確定させる）。いずれかの科目で在庫が足りない場合は何も更新せずnullを返す
 * （部分的な予約状態を残さない）。profileは必須引数 ── 本人・動作テスト用はそれぞれ
 * 独立した実戦模試プールを持ち、自分自身のプールからのみ予約する（topUpExamPoolも
 * profileごとに独立して補充する）。
 */
export async function reserveQuestionsForPart(part: ExamPart, profile: string): Promise<number[] | null> {
  const sb = supabase();
  const bySubject: number[][] = [];
  for (const { subject, questions } of subjectsForPart(part)) {
    const { data, error } = await sb
      .from("questions")
      .select("id")
      .eq("subject", subject)
      .eq("pool", "exam")
      .eq("status", "active")
      .eq("profile", profile)
      .limit(questions);
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((r) => r.id as number);
    if (ids.length < questions) return null;
    bySubject.push(ids);
  }
  const allIds = bySubject.flat();
  const { error: updateError } = await sb.from("questions").update({ pool: "general" }).in("id", allIds);
  if (updateError) throw new Error(updateError.message);
  return allIds;
}

export type SubjectScore = { subject: string; correct: number; total: number };

/**
 * 指定した問題id群に対する、そのexam_attempt内での正誤を集計する。同じ問題に複数回
 * 解答記録がある場合は最新のものを採用する（通常は1問1回のみのはずだが念のため）。
 */
export async function computePartResult(
  examAttemptId: number,
  questionIds: number[],
): Promise<{ correct: number; total: number; bySubject: SubjectScore[] }> {
  const sb = supabase();
  if (questionIds.length === 0) return { correct: 0, total: 0, bySubject: [] };
  const [{ data: questions }, { data: attempts }] = await Promise.all([
    sb.from("questions").select("id, subject").in("id", questionIds),
    sb
      .from("attempts")
      .select("question_id, is_correct, answered_at")
      .eq("exam_attempt_id", examAttemptId)
      .in("question_id", questionIds)
      .order("answered_at", { ascending: false }),
  ]);
  const subjectById = new Map((questions ?? []).map((q) => [q.id as number, q.subject as string]));
  const latestByQuestion = new Map<number, boolean>();
  for (const a of attempts ?? []) {
    if (!latestByQuestion.has(a.question_id)) latestByQuestion.set(a.question_id, a.is_correct as boolean);
  }

  const bySubjectMap = new Map<string, SubjectScore>();
  let correct = 0;
  for (const id of questionIds) {
    const subject = subjectById.get(id) ?? "不明";
    const ok = latestByQuestion.get(id) ?? false; // 未回答（時間切れ）は不正解扱い
    const s = bySubjectMap.get(subject) ?? { subject, correct: 0, total: 0 };
    s.total++;
    if (ok) {
      s.correct++;
      correct++;
    }
    bySubjectMap.set(subject, s);
  }
  return { correct, total: questionIds.length, bySubject: [...bySubjectMap.values()] };
}

export type ExamVerdict = {
  passed: boolean;
  overallRate: number;
  totalCorrect: number;
  totalQuestions: number;
  failedGroups: string[];
};

/** 科目群（①〜⑨）ごとに0点があれば不合格、かつ総得点率60%未満でも不合格（本番の合格基準に準拠）。 */
export function computeVerdict(bySubjectAll: SubjectScore[]): ExamVerdict {
  const bySubjectMap = new Map(bySubjectAll.map((s) => [s.subject, s]));
  const failedGroups: string[] = [];
  for (const group of EXAM_SUBJECT_GROUPS) {
    const groupCorrect = group.subjects.reduce((sum, subj) => sum + (bySubjectMap.get(subj)?.correct ?? 0), 0);
    if (groupCorrect === 0) failedGroups.push(group.label);
  }
  const totalCorrect = bySubjectAll.reduce((sum, s) => sum + s.correct, 0);
  const totalQuestions = bySubjectAll.reduce((sum, s) => sum + s.total, 0);
  const overallRate = totalQuestions > 0 ? totalCorrect / totalQuestions : 0;
  const passed = failedGroups.length === 0 && overallRate >= EXAM_PASS_SCORE_RATE;
  return { passed, overallRate, totalCorrect, totalQuestions, failedGroups };
}
