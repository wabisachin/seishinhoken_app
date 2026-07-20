import { generateObject } from "ai";
import { z } from "zod";
import { supabase } from "./supabase";
import { listSubjects } from "./subjects";
import { getWrongStockProgressBySubject, getEverMissedQuestionIds } from "./reviewStock";
import { EXAM_SUBJECT_GROUPS, EXAM_ROUND_LABEL, daysUntilExam } from "./examFormat";
import { getModel } from "./llm";
import { getLlmSettings } from "./appSettings";
import { logUsage } from "./usageLog";

// 1セットあたりの問題数。
const SET_SIZE = 5;
// 1つの(科目×カテゴリ)セルに配分が集中しすぎないための上限セット数（=最大30問/月/セル）。
// 復習ストックがどれだけ多くても、1科目だけで月間予算を食い尽くさないためのガード。
const MAX_SETS_PER_CELL = 6;
// この解答数（重複除去）に届いていない科目は「まだ判断材料が薄い」とみなす
// （lib/nextAction.ts の CONFIDENCE_THRESHOLD と同じ考え方を独立に持つ）。
const THIN_THRESHOLD = 30;
// 復習ストックがこの問数を超えている科目は「積み上がりすぎ」とみなす（ユーザー指示:
// 復習が溜まりすぎるとやる気を削ぐため、超過分を優先的に消化する配分にする）。
// lib/nextAction.ts の REVIEW_BACKLOG_SATURATION と同じ考え方を独立に持つ
// （克服条件が1回正解になり3倍消化しやすくなったため、しきい値も3倍(60)にしてある）。
const REVIEW_BACKLOG_SATURATION = 60;

export type SubjectPlanEntry = {
  subject: string;
  /** 復習セット数（1セット=SET_SIZE問。間違えたまま残っている問題の中から出題） */
  reviewSets: number;
  /** 演習セット数（1セット=SET_SIZE問。新規/母数を増やすための出題） */
  practiceSets: number;
};

export type MonthlyPlan = {
  bySubject: SubjectPlanEntry[];
  setSize: number;
  /** 科目数×(復習/演習)2カテゴリ。LLMはこの合計の中で配分先を決めるだけで、合計値自体は変えない。 */
  totalSets: number;
  totalTarget: number;
  /** 配分の全体的な考え方（LLMの一言）。振り返りレポートの文章生成(monthlyReport.ts)の材料にする。 */
  allocationRationale: string;
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

type SubjectInput = {
  subject: string;
  attempts: number;
  currentWrong: number;
  isThin: boolean;
  /** 科目群（合格基準の①〜⑨）の中で誰もTHIN_THRESHOLD問に届いていない＝0点科目群リスク最大。 */
  inPriorityGroup: boolean;
  /** 復習セットの上限。復習ストックが無ければ0（消化しようが無いセットを配分しても意味が無いため）。 */
  reviewCap: number;
  practiceCap: number;
};

/** 配分判断に必要な、科目ごとの決定的な現状データを集める（LLM不使用）。 */
async function gatherSubjectInputs(profile: string): Promise<SubjectInput[]> {
  const subjects = await listSubjects();
  const [wrongBySubject, attemptCounts] = await Promise.all([
    getWrongStockProgressBySubject(profile),
    countAttemptsBySubject(profile),
  ]);

  const subjectGroupLabel = new Map<string, string>();
  for (const group of EXAM_SUBJECT_GROUPS) {
    for (const s of group.subjects) subjectGroupLabel.set(s, group.label);
  }
  const groupThin = new Map<string, boolean>();
  for (const group of EXAM_SUBJECT_GROUPS) {
    const anyPracticed = group.subjects.some((s) => (attemptCounts.get(s) ?? 0) >= THIN_THRESHOLD);
    groupThin.set(group.label, !anyPracticed);
  }

  return subjects.map((subject) => {
    const attempts = attemptCounts.get(subject) ?? 0;
    const currentWrong = wrongBySubject.get(subject)?.currentWrong ?? 0;
    const isThin = attempts < THIN_THRESHOLD;
    const groupLabel = subjectGroupLabel.get(subject);
    const inPriorityGroup = groupLabel ? (groupThin.get(groupLabel) ?? false) : false;
    // 復習ストックがSET_SIZE問に届いていなくても、1セットぶんの枠は与えておく
    // （0問ちょうどの科目だけ0にする。それ以外は切り上げでセット化する）。
    const reviewCap = currentWrong === 0 ? 0 : Math.min(MAX_SETS_PER_CELL, Math.ceil(currentWrong / SET_SIZE));
    return { subject, attempts, currentWrong, isThin, inPriorityGroup, reviewCap, practiceCap: MAX_SETS_PER_CELL };
  });
}

const AllocationSchema = z.object({
  bySubject: z
    .array(
      z.object({
        subject: z.string(),
        reviewWeight: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe("復習(間違えたまま残っている問題を克服する)にどれだけ重点を置くか。0=不要、5=最優先"),
        practiceWeight: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe("演習(新しい問題で母数を増やす)にどれだけ重点を置くか。0=不要、5=最優先"),
      }),
    )
    .describe("科目リストの全件を1件ずつ、渡された順序通りに含めること"),
  rationale: z
    .string()
    .describe("この配分にした全体的な考え方を1〜2文で。個別科目ごとの理由の羅列ではなく、全体としての方針を書く"),
});

/**
 * 科目ごとの現状データをもとに、復習/演習それぞれへの相対的な重み(0〜5)をLLMに判断させる
 * プロンプトを組み立てる。実際のセット数への変換（合計を必ずtotalSetsに一致させる処理）は
 * コード側(normalizeAllocation)が担うため、ここではLLMに正確な合計を守らせる必要はない
 * ── LLMは「相対的にどこに重点を置くべきか」の判断だけに専念させる。
 */
function buildAllocationPrompt(inputs: SubjectInput[], examDaysRemaining: number): string {
  const currentWrongValues = inputs.map((i) => i.currentWrong);
  const attemptValues = inputs.map((i) => i.attempts);
  const maxWrong = Math.max(...currentWrongValues);
  const minWrong = Math.min(...currentWrongValues);
  const maxAttempts = Math.max(...attemptValues);
  const minAttempts = Math.min(...attemptValues);

  // 復習ストックが多い順に並べる。LLMが「絶対値としてどれも重要そう」という理由で
  // 横並びの重みを付けてしまう(実測で確認済みの失敗パターン)のを避けるため、絶対値の
  // 説明だけでなく相対順位を直接見せて、順位に応じた重みの差をつけやすくする。
  const sorted = [...inputs].sort((a, b) => b.currentWrong - a.currentWrong);
  const lines = sorted
    .map((i, idx) => {
      const parts = [
        `復習ストック${i.currentWrong}問(上限${i.reviewCap}セット、復習ストックの多さで${idx + 1}位/${inputs.length}科目中)`,
        `解答数${i.attempts}問${i.isThin ? "(まだ薄い)" : ""}`,
      ];
      if (i.currentWrong > REVIEW_BACKLOG_SATURATION) {
        parts.push(`目安の${REVIEW_BACKLOG_SATURATION}問を${i.currentWrong - REVIEW_BACKLOG_SATURATION}問超過`);
      }
      if (i.inPriorityGroup) parts.push("科目群内で誰もデータ十分な科目が無い(0点科目群リスク最大)");
      return `- ${i.subject}: ${parts.join("、")}`;
    })
    .join("\n");

  const overSaturated = sorted.filter((i) => i.currentWrong > REVIEW_BACKLOG_SATURATION);

  return `あなたは精神保健福祉士国家試験対策アプリの学習コーチです。${EXAM_ROUND_LABEL}本番まであと${examDaysRemaining}日です。

今月の学習量は合計36セット（1セット=${SET_SIZE}問、全${inputs.length}科目×(復習/演習)2カテゴリの
組み合わせに配分）に固定されています。あなたの仕事は、この固定された総量をどの科目・
どちらのカテゴリに重点的に配分すべきか、科目ごとに0〜5の重み(reviewWeight/practiceWeight)で
判断することです。重みが高いほど多くのセットが配分されます（重みから実際のセット数への
変換や、上限を超えないようにする調整はコード側で行うため、あなたは相対的な重要度の判断
だけに専念してください。合計を意識する必要はありません）。

# 最重要: 必ず重みに差をつけること
全科目の復習ストック数は${minWrong}〜${maxWrong}問、解答数は${minAttempts}〜${maxAttempts}問と、
科目間で大きくばらついています。それにもかかわらず全科目・両カテゴリにほぼ同じ重み
（例: 全部3、全部同じ1点刻みの横並び）を付けるのは誤りです。それは「みんな大事に見える
から横並びにする」という安全策であり、あなたに求められている判断ではありません。
下記の「復習ストックの多さの順位」を必ず参照し、上位科目（1〜6位あたり）はreviewWeightを
4〜5、中位（7〜12位あたり）は2〜3、下位（13位以降、特にストック0の科目）は0〜1、と
明確に段差をつけてください。practiceWeightも同様に、解答数が少ない科目ほど高く、
既に十分な科目ほど低くなるよう段差をつけてください。

# 配分方針
- 復習ストック(間違えたまま残っている問題)が多い科目ほど、reviewWeightを高くしてください
  （逆に復習ストックが無い/少ない科目にreviewWeightを付けても消化しようが無いため0にしてください。
  上限セット数(◯セット)が0の科目は、reviewWeightを何点にしても復習には配分されません）
- 復習ストックが少ない・無い科目や、まだ解答数が薄い科目は、practiceWeightを高くして
  新しい問題で母数を増やす方に振ってください
- 科目群内で誰もデータが十分でない科目（0点科目群リスク最大、と付記した科目）は、
  practiceWeightを優先的に高くしてください（本番で科目群まるごと0点を引くリスクが最も高いため）
- 復習ストックも十分に消化されていて、解答数も十分な科目（もう手薄でも弱点でもない科目）は
  両方の重みを低くしてよい（0でよい）。全科目に何かしら配分する必要は無い
${
  overSaturated.length > 0
    ? `- 【重要】復習ストックが目安の${REVIEW_BACKLOG_SATURATION}問を超えて積み上がっている科目があります
  （${overSaturated.map((i) => `${i.subject}(${i.currentWrong}問、${i.currentWrong - REVIEW_BACKLOG_SATURATION}問超過)`).join("、")}）。
  復習ストックが積み上がりすぎるとユーザーのやる気を削ぐため、これらの科目は超過分を
  優先的に消化できるよう、reviewWeightを最優先（5）にしてください。同時に、これ以上
  積み上げないよう、これらの科目のpracticeWeightは低めに抑えてください（新しい問題を
  増やすより先に、既存の復習ストックを減らすことを優先する）`
    : ""
}

# 科目ごとの現状（復習ストックが多い順）
${lines}`;
}

type AllocationResult = z.infer<typeof AllocationSchema>;

/**
 * LLMが返した0〜5の相対重みを、科目ごとの上限(cap)を守りつつ、必ずtotalSetsちょうどに
 * 収まる整数配分へ変換する（LLMに正確な合計を守らせるのは信頼できないため、数値の
 * 一貫性はここで機械的に保証する）。重みに比例した理想値を算出→切り捨て→端数の大きい
 * 順に1ずつ追加、を上限に達したセルを除外しながら複数ラウンド繰り返す
 * （largest remainder法の、上限つき・複数ラウンド版）。
 */
function normalizeAllocation(
  inputs: SubjectInput[],
  weights: AllocationResult["bySubject"],
  totalSets: number,
): Map<string, { reviewSets: number; practiceSets: number }> {
  const weightBySubject = new Map(weights.map((w) => [w.subject, w]));
  type Cell = { key: string; weight: number; cap: number };
  const cells: Cell[] = [];
  for (const input of inputs) {
    const w = weightBySubject.get(input.subject);
    cells.push({ key: `${input.subject}::review`, weight: w?.reviewWeight ?? 0, cap: input.reviewCap });
    cells.push({ key: `${input.subject}::practice`, weight: w?.practiceWeight ?? 0, cap: input.practiceCap });
  }

  const allocation = new Map<string, number>(cells.map((c) => [c.key, 0]));
  let remaining = totalSets;
  // weight=0または上限0のセルは対象外。全セルが対象外になった場合（LLM出力が全て0等の
  // 縮退ケース）は、上限>0のセルを均等重みとして扱う保険を入れる。
  let active = cells.filter((c) => c.cap > 0 && c.weight > 0);
  if (active.length === 0) active = cells.filter((c) => c.cap > 0).map((c) => ({ ...c, weight: 1 }));

  let guard = 0;
  while (remaining > 0 && active.length > 0 && guard < 100) {
    guard++;
    const totalWeight = active.reduce((s, c) => s + c.weight, 0);
    if (totalWeight <= 0) break;
    let roundGiven = 0;
    const remainders: { key: string; frac: number; cap: number }[] = [];
    for (const c of active) {
      const ideal = (remaining * c.weight) / totalWeight;
      const headroom = c.cap - (allocation.get(c.key) ?? 0);
      const give = Math.max(0, Math.min(Math.floor(ideal), headroom));
      if (give > 0) {
        allocation.set(c.key, (allocation.get(c.key) ?? 0) + give);
        roundGiven += give;
      }
      remainders.push({ key: c.key, frac: ideal - Math.floor(ideal), cap: c.cap });
    }
    remaining -= roundGiven;
    if (remaining > 0) {
      remainders.sort((a, b) => b.frac - a.frac);
      for (const r of remainders) {
        if (remaining <= 0) break;
        const cur = allocation.get(r.key) ?? 0;
        if (cur < r.cap) {
          allocation.set(r.key, cur + 1);
          remaining--;
        }
      }
    }
    active = active.filter((c) => (allocation.get(c.key) ?? 0) < c.cap);
    if (roundGiven === 0) break; // 全セルが上限に達しており、これ以上配りようが無い
  }

  const result = new Map<string, { reviewSets: number; practiceSets: number }>();
  for (const input of inputs) {
    result.set(input.subject, {
      reviewSets: allocation.get(`${input.subject}::review`) ?? 0,
      practiceSets: allocation.get(`${input.subject}::practice`) ?? 0,
    });
  }
  return result;
}

/**
 * 今月の学習プランを算出する。総量（36セット=180問）は科目数から機械的に決まる固定値で、
 * LLMに発明させない。LLMが判断するのはその固定量を「どの科目のどちらのカテゴリに
 * 重点配分するか」という相対的な優先度だけで、実際のセット数への変換・上限遵守・
 * 合計値の一致はすべてコード側(normalizeAllocation)が機械的に保証する
 * （数値の一貫性・信頼性を優先するための設計。振り返りレポート生成LLM(lib/monthlyReport.ts)
 * はこのプランの数値をさらに発明することはなく、意味づけの文章だけを書く）。
 */
export async function computeMonthlyPlan(profile: string): Promise<MonthlyPlan> {
  const inputs = await gatherSubjectInputs(profile);
  const examDaysRemaining = daysUntilExam();
  // 科目数×(復習/演習)2カテゴリ。科目が18なら36セット=180問が月間の固定量になる。
  const totalSets = inputs.length * 2;

  const llm = await getLlmSettings();
  const model = getModel(llm);
  const { object, usage } = await generateObject({
    model,
    schema: AllocationSchema,
    prompt: buildAllocationPrompt(inputs, examDaysRemaining),
  });
  await logUsage({ source: "plan-allocate", provider: llm.provider, model: llm.model, usage });

  const allocationMap = normalizeAllocation(inputs, object.bySubject, totalSets);
  const bySubject: SubjectPlanEntry[] = inputs.map((input) => {
    const a = allocationMap.get(input.subject) ?? { reviewSets: 0, practiceSets: 0 };
    return { subject: input.subject, reviewSets: a.reviewSets, practiceSets: a.practiceSets };
  });
  bySubject.sort((a, b) => b.reviewSets + b.practiceSets - (a.reviewSets + a.practiceSets));

  return {
    bySubject,
    setSize: SET_SIZE,
    totalSets,
    totalTarget: totalSets * SET_SIZE,
    allocationRationale: object.rationale,
    computedAt: new Date().toISOString(),
    examDaysRemaining,
  };
}

export type PlanProgress = {
  reportId: number;
  planTotal: number;
  doneTotal: number;
  bySubject: { subject: string; target: number; done: number }[];
};

/**
 * 最新の振り返りレポートのプランと、今月実際の消化状況を比較する。ダッシュボードの進捗
 * カード（api/reports/plan-progress）と、おすすめの次の一手のコンテキスト（nextAction.ts）
 * の両方から呼ぶ共通ロジック。レポートが1件も無ければnull。period_monthとの日付マッチは
 * させず常に最新1件を使う（タイムゾーンのずれ・月初のcron未実行タイミングでのoff-by-oneを
 * 避けるため）。
 *
 * 復習セットの消化判定は「現在克服済みかどうか」は問わない ── 復習ストックが増えるほど
 * 同じ問題に巡り合う機会自体が減り、母数依存で理不尽に難しくなるため。代わりに
 * 「一度でも間違えたことがある問題を、今月中に一度でも正解できたか」を消化の基準にする
 * （getEverMissedQuestionIdsで判定。現在克服済みかどうかは問わない＝今月中に完全に
 * 克服した問題も当然カウントされる）。演習セットの消化判定は従来通り「解いたか」のみ
 * （一度も間違えたことが無い問題を解いた場合に限る。復習側との二重カウントを避けるため）。
 */
export async function getPlanProgress(profile: string): Promise<PlanProgress | null> {
  const sb = supabase();
  const { data: latest, error } = await sb
    .from("monthly_reports")
    .select("id, plan")
    .eq("profile", profile)
    .order("period_month", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!latest) return null;

  const plan = latest.plan as MonthlyPlan;
  const setSize = plan.setSize ?? 5;
  const thisMonth = new Date().toISOString().slice(0, 7);

  const [everMissedIds, attemptsRes] = await Promise.all([
    getEverMissedQuestionIds(profile),
    sb
      .from("attempts")
      .select("question_id, is_correct, questions!inner(subject)")
      .eq("profile", profile)
      .gte("answered_at", `${thisMonth}-01`),
  ]);
  if (attemptsRes.error) throw new Error(attemptsRes.error.message);

  const reviewDoneBySubject = new Map<string, Set<number>>();
  const practiceDoneBySubject = new Map<string, Set<number>>();
  type Row = { question_id: number; is_correct: boolean; questions: { subject: string } | null };
  for (const row of (attemptsRes.data ?? []) as unknown as Row[]) {
    const subject = row.questions?.subject;
    if (!subject) continue;
    if (everMissedIds.has(row.question_id)) {
      if (!row.is_correct) continue; // 復習は「正解できた」ことをもって1カウントする
      const set = reviewDoneBySubject.get(subject) ?? new Set<number>();
      set.add(row.question_id);
      reviewDoneBySubject.set(subject, set);
    } else {
      const set = practiceDoneBySubject.get(subject) ?? new Set<number>();
      set.add(row.question_id);
      practiceDoneBySubject.set(subject, set);
    }
  }

  let planTotal = 0;
  let doneTotal = 0;
  const bySubject = plan.bySubject
    .filter((s) => s.reviewSets + s.practiceSets > 0)
    .map((s) => {
      const reviewTarget = s.reviewSets * setSize;
      const practiceTarget = s.practiceSets * setSize;
      const target = reviewTarget + practiceTarget;
      const reviewDone = Math.min(reviewTarget, reviewDoneBySubject.get(s.subject)?.size ?? 0);
      const practiceDone = Math.min(practiceTarget, practiceDoneBySubject.get(s.subject)?.size ?? 0);
      const done = reviewDone + practiceDone;
      planTotal += target;
      doneTotal += done;
      return { subject: s.subject, target, done };
    });

  return { reportId: latest.id as number, planTotal, doneTotal, bySubject };
}
