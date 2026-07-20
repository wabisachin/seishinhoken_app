import { supabase } from "./supabase";
import { listSubjects } from "./subjects";
import { getWrongStockProgressBySubject } from "./reviewStock";
import { EXAM_SUBJECT_GROUPS, daysUntilExam } from "./examFormat";

// 1科目あたりの復習目標の上限。残弱点を一気に全部潰そうとすると達成できず
// 挫折感につながるため、あくまで「今月これだけやれば前進できる」という
// クリアしやすい量に抑える（ユーザー指示: 達成可能であることを最優先する）。
const REVIEW_CAP_PER_SUBJECT = 5;
// 未挑戦・データが薄い科目に課す演習目標の基準値。
const PRACTICE_BASELINE = 5;
// この解答数（重複除去）に届いていない科目は「まだ判断材料が薄い」とみなす
// （lib/nextAction.ts の CONFIDENCE_THRESHOLD と同じ考え方を独立に持つ）。
const THIN_THRESHOLD = 30;

export type SubjectPlanEntry = {
  subject: string;
  reviewTarget: number;
  practiceTarget: number;
  /** 1が最優先。科目群（合格基準の①〜⑨）の中で誰も十分に演習していない科目ほど小さい値になる。 */
  priorityRank: 1 | 2 | 3;
};

export type MonthlyPlan = {
  bySubject: SubjectPlanEntry[];
  totalTarget: number;
  computedAt: string;
  examDaysRemaining: number;
};

/** attempts を科目ごとに、重複の無い問題数（=解答数）で集計する（review-summaryルートと同じ考え方）。 */
async function countAttemptsBySubject(profile: string): Promise<Map<string, number>> {
  const { data, error } = await supabase()
    .from("attempts")
    .select("question_id, questions!inner(subject)")
    .eq("profile", profile);
  if (error) throw new Error(error.message);
  const bySubject = new Map<string, Set<number>>();
  for (const row of (data ?? []) as unknown as { question_id: number; questions: { subject: string } | null }[]) {
    const subject = row.questions?.subject;
    if (!subject) continue;
    const set = bySubject.get(subject) ?? new Set<number>();
    set.add(row.question_id);
    bySubject.set(subject, set);
  }
  const result = new Map<string, number>();
  for (const [subject, set] of bySubject) result.set(subject, set.size);
  return result;
}

/**
 * 今月の学習プランを決定的（LLM不使用）に算出する。数値はコードで計算し、
 * 振り返りレポート生成LLM(lib/monthlyReport.ts)はこの数値を発明せず、意味づけの
 * 文章だけを書く（数値の一貫性・信頼性を優先するための設計）。
 *
 * 優先度(priorityRank)は「科目群（合格基準の①〜⑨）の中でどの科目もTHIN_THRESHOLD問に
 * 届いていない」＝本番で0点科目群を引くリスクが最も高い科目群を最優先(1)にする。
 * 次点(2)は残弱点がある、または解答数が薄い科目。それ以外(3)は現状維持でよい科目。
 */
export async function computeMonthlyPlan(profile: string): Promise<MonthlyPlan> {
  const subjects = await listSubjects();
  // 在庫状況(questionSupply.tsのgetStockSnapshot)は意図的に目標値へ反映しない。
  // 在庫確保はquestionSupply.ts裏側のかんばん補充の責務であり、学習プランの責務ではない
  // （在庫が薄いからといって目標を下げると、本来解くべき量の指標としての意味が薄れる）。
  const [wrongBySubject, attemptCounts] = await Promise.all([
    getWrongStockProgressBySubject(profile),
    countAttemptsBySubject(profile),
  ]);

  const subjectGroupLabel = new Map<string, string>();
  for (const group of EXAM_SUBJECT_GROUPS) {
    for (const s of group.subjects) subjectGroupLabel.set(s, group.label);
  }
  // 科目群ごとに「その群の中で1科目でもTHIN_THRESHOLD問以上こなしているか」を判定する。
  // 1科目もこなしていない群は、本番で丸ごと0点を引くリスクが最も高い最優先グループ。
  const groupThin = new Map<string, boolean>();
  for (const group of EXAM_SUBJECT_GROUPS) {
    const anyPracticed = group.subjects.some((s) => (attemptCounts.get(s) ?? 0) >= THIN_THRESHOLD);
    groupThin.set(group.label, !anyPracticed);
  }

  const bySubject: SubjectPlanEntry[] = subjects.map((subject) => {
    const attempts = attemptCounts.get(subject) ?? 0;
    const currentWrong = wrongBySubject.get(subject)?.currentWrong ?? 0;
    const isThin = attempts < THIN_THRESHOLD;
    const reviewTarget = Math.min(currentWrong, REVIEW_CAP_PER_SUBJECT);
    const practiceTarget = isThin ? PRACTICE_BASELINE : 0;

    const groupLabel = subjectGroupLabel.get(subject);
    const inPriorityGroup = groupLabel ? (groupThin.get(groupLabel) ?? false) : false;
    const priorityRank: 1 | 2 | 3 = inPriorityGroup ? 1 : isThin || currentWrong > 0 ? 2 : 3;

    return { subject, reviewTarget, practiceTarget, priorityRank };
  });

  bySubject.sort((a, b) => a.priorityRank - b.priorityRank || b.reviewTarget + b.practiceTarget - (a.reviewTarget + a.practiceTarget));
  const totalTarget = bySubject.reduce((sum, e) => sum + e.reviewTarget + e.practiceTarget, 0);

  return { bySubject, totalTarget, computedAt: new Date().toISOString(), examDaysRemaining: daysUntilExam() };
}

export type PlanProgress = {
  planTotal: number;
  doneTotal: number;
  bySubject: { subject: string; target: number; done: number }[];
};

/**
 * 最新の振り返りレポートのプランと、今月実際に解答した問題数（科目別・重複除去）を比較する。
 * ダッシュボードの進捗カード（api/reports/plan-progress）と、おすすめの次の一手の
 * コンテキスト（nextAction.ts）の両方から呼ぶ共通ロジック。レポートが1件も無ければnull。
 * period_monthとの日付マッチはさせず常に最新1件を使う（タイムゾーンのずれ・月初の
 * cron未実行タイミングでのoff-by-oneを避けるため）。
 */
export async function getPlanProgress(profile: string): Promise<PlanProgress | null> {
  const sb = supabase();
  const { data: latest, error } = await sb
    .from("monthly_reports")
    .select("plan")
    .eq("profile", profile)
    .order("period_month", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!latest) return null;

  const plan = latest.plan as MonthlyPlan;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const { data: attempts, error: aError } = await sb
    .from("attempts")
    .select("question_id, questions!inner(subject)")
    .eq("profile", profile)
    .gte("answered_at", `${thisMonth}-01`);
  if (aError) throw new Error(aError.message);

  const doneBySubject = new Map<string, Set<number>>();
  for (const row of (attempts ?? []) as unknown as { question_id: number; questions: { subject: string } | null }[]) {
    const subject = row.questions?.subject;
    if (!subject) continue;
    const set = doneBySubject.get(subject) ?? new Set<number>();
    set.add(row.question_id);
    doneBySubject.set(subject, set);
  }

  let planTotal = 0;
  let doneTotal = 0;
  const bySubject = plan.bySubject
    .filter((s) => s.reviewTarget + s.practiceTarget > 0)
    .map((s) => {
      const target = s.reviewTarget + s.practiceTarget;
      const done = Math.min(target, doneBySubject.get(s.subject)?.size ?? 0);
      planTotal += target;
      doneTotal += done;
      return { subject: s.subject, target, done };
    });

  return { planTotal, doneTotal, bySubject };
}
