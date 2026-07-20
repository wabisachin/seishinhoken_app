import { generateObject } from "ai";
import { z } from "zod";
import { supabase } from "./supabase";
import { getModel } from "./llm";
import { getLlmSettings } from "./appSettings";
import { logUsage } from "./usageLog";
import { computeMonthlyPlan, type MonthlyPlan } from "./monthlyPlan";
import { daysUntilExam } from "./examFormat";
import { computePartResult, computeVerdict, type ExamAttemptRow } from "./examMode";

// 誤答パターン分析(ステージ1)の対象件数。対象月固定ではなく直近N件にしている理由:
// (a) 動作テスト用は移行済みの古いデータのため、月固定だと分析対象が空になってしまう、
// (b) 1カ月分だけでは統計的に心もとない（弱点の傾向を導くにはある程度のサンプルが要る）。
// 大きくするほど分析精度は上がるがLLMコストも上がるため60件に固定する。
const MISTAKE_ANALYSIS_WINDOW = 60;
const REQUIRED_STREAK = 3;

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

type QuestionHistory = {
  subject: string;
  major: string | null;
  middle: string | null;
  minor: string | null;
  caseText: string | null;
  questionType: "single" | "multi";
  stem: string;
  options: string[];
  correct: number[];
  explanations: string[];
  history: { is_correct: boolean; answered_at: string; selected: number[] }[];
};

/**
 * 指定profileの全解答履歴を、問題の内容（科目・タクソノミー・本文・解説）付きで
 * 問題単位に集約して返す。月次メトリクス・形式別弱点・誤答パターン分析(直近N件抽出)の
 * 3つすべてがこの1回のフェッチから導出できるようにする（クエリを使い回すため）。
 */
async function fetchFullHistory(profile: string): Promise<Map<number, QuestionHistory>> {
  const sb = supabase();
  const { data: attempts, error } = await sb
    .from("attempts")
    .select("question_id, is_correct, answered_at, selected")
    .eq("profile", profile)
    .order("answered_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (!attempts || attempts.length === 0) return new Map();

  const questionIds = [...new Set(attempts.map((a) => a.question_id as number))];
  const { data: questions, error: qError } = await sb
    .from("questions")
    .select("id, subject, taxonomy_id, case_text, question_type, stem, options, correct, explanations")
    .in("id", questionIds);
  if (qError) throw new Error(qError.message);

  const taxonomyIds = [...new Set((questions ?? []).map((q) => q.taxonomy_id as number | null).filter((x): x is number => x != null))];
  const { data: taxonomyRows } = taxonomyIds.length
    ? await sb.from("taxonomy").select("id, major, middle, minor").in("id", taxonomyIds)
    : { data: [] as { id: number; major: string | null; middle: string | null; minor: string | null }[] };
  const taxonomyById = new Map((taxonomyRows ?? []).map((t) => [t.id as number, t]));
  const questionById = new Map((questions ?? []).map((q) => [q.id as number, q]));

  const result = new Map<number, QuestionHistory>();
  for (const a of attempts) {
    const qid = a.question_id as number;
    const q = questionById.get(qid);
    if (!q) continue;
    const tax = q.taxonomy_id != null ? taxonomyById.get(q.taxonomy_id as number) : undefined;
    const entry: QuestionHistory =
      result.get(qid) ??
      {
        subject: q.subject as string,
        major: tax?.major ?? null,
        middle: tax?.middle ?? null,
        minor: tax?.minor ?? null,
        caseText: q.case_text as string | null,
        questionType: q.question_type as "single" | "multi",
        stem: q.stem as string,
        options: q.options as string[],
        correct: q.correct as number[],
        explanations: q.explanations as string[],
        history: [],
      };
    entry.history.push({
      is_correct: a.is_correct as boolean,
      answered_at: a.answered_at as string,
      selected: (a.selected as number[]) ?? [],
    });
    result.set(qid, entry);
  }
  return result;
}

export type ExamMonthSummary = {
  roundsCount: number;
  averageRate: number; // 0-100（その月に完了した回の得点率の平均）
  passCount: number;
  failCount: number;
  zeroScoreGroupOccurrences: number; // その月の完了回を通じて「科目群が0点」だった延べ回数
  topStrongSubjects: { subject: string; rate: number }[];
  topWeakSubjects: { subject: string; rate: number }[];
} | null;

export type MonthMetrics = {
  periodMonth: string; // "YYYY-MM"
  answeredThisMonth: number;
  newWeaknessesDiscovered: number;
  weaknessesOvercome: number;
  bySubjectWrong: { subject: string; wrongCount: number }[];
  byMinorWrong: { subject: string; minor: string; wrongCount: number }[];
  examSummary: ExamMonthSummary;
};

/**
 * 対象月(periodMonth="YYYY-MM")に完了した実戦模試（両パート完了）の結果を集計する。
 * lib/examMode.tsのcomputePartResult/computeVerdict（api/exam/history/routeと同じ判定）を
 * 再利用し、合否・科目群0点判定のロジックを重複させない。完了回が1件も無ければnull。
 */
async function fetchExamMonthSummary(profile: string, periodMonth: string): Promise<ExamMonthSummary> {
  const sb = supabase();
  const { data: rows, error } = await sb
    .from("exam_attempts")
    .select("*")
    .eq("profile", profile)
    .eq("common_status", "completed")
    .eq("specialized_status", "completed");
  if (error) throw new Error(error.message);

  const roundsInMonth = ((rows ?? []) as ExamAttemptRow[]).filter((row) => {
    const commonAt = row.common_completed_at ? new Date(row.common_completed_at).getTime() : 0;
    const specializedAt = row.specialized_completed_at ? new Date(row.specialized_completed_at).getTime() : 0;
    const completedAt = new Date(Math.max(commonAt, specializedAt)).toISOString();
    return monthKey(completedAt) === periodMonth;
  });
  if (roundsInMonth.length === 0) return null;

  const results = await Promise.all(
    roundsInMonth.map(async (row) => {
      const [commonResult, specializedResult] = await Promise.all([
        computePartResult(row.id, row.common_question_ids ?? []),
        computePartResult(row.id, row.specialized_question_ids ?? []),
      ]);
      const bySubject = [...commonResult.bySubject, ...specializedResult.bySubject];
      return { bySubject, verdict: computeVerdict(bySubject) };
    }),
  );

  let passCount = 0;
  let failCount = 0;
  let zeroScoreGroupOccurrences = 0;
  let rateSum = 0;
  const subjectAgg = new Map<string, { correct: number; total: number }>();
  for (const { bySubject, verdict } of results) {
    if (verdict.passed) passCount++;
    else failCount++;
    zeroScoreGroupOccurrences += verdict.failedGroups.length;
    rateSum += verdict.overallRate;
    for (const s of bySubject) {
      const entry = subjectAgg.get(s.subject) ?? { correct: 0, total: 0 };
      entry.correct += s.correct;
      entry.total += s.total;
      subjectAgg.set(s.subject, entry);
    }
  }

  const bySubjectRate = [...subjectAgg.entries()]
    .map(([subject, { correct, total }]) => ({ subject, rate: total > 0 ? Math.round((100 * correct) / total) : 0 }))
    .sort((a, b) => b.rate - a.rate);

  return {
    roundsCount: roundsInMonth.length,
    averageRate: Math.round((100 * rateSum) / results.length),
    passCount,
    failCount,
    zeroScoreGroupOccurrences,
    topStrongSubjects: bySubjectRate.slice(0, 3),
    topWeakSubjects: [...bySubjectRate].reverse().slice(0, 3),
  };
}

/**
 * 対象月(periodMonth="YYYY-MM")の決定的な集計。LLMは使わない。
 * - answeredThisMonth: 今月解答した問題数（重複除去）
 * - newWeaknessesDiscovered: 「初めて間違えた日」が今月だった問題数
 * - weaknessesOvercome: 「3連続正解に初めて到達した瞬間」が今月だった回数
 *   （克服後に再び間違えて、その後また3連続正解に到達すれば再克服として再度カウントする）
 */
function computeMonthMetrics(histories: Map<number, QuestionHistory>, periodMonth: string): Omit<MonthMetrics, "examSummary"> {
  let answeredThisMonth = 0;
  let newWeaknessesDiscovered = 0;
  let weaknessesOvercome = 0;
  const wrongBySubject = new Map<string, number>();
  const wrongByMinor = new Map<string, { subject: string; minor: string; count: number }>();

  for (const { subject, minor, history } of histories.values()) {
    if (history.some((h) => monthKey(h.answered_at) === periodMonth)) answeredThisMonth++;

    const wrongThisMonthCount = history.filter((h) => !h.is_correct && monthKey(h.answered_at) === periodMonth).length;
    if (wrongThisMonthCount > 0) {
      wrongBySubject.set(subject, (wrongBySubject.get(subject) ?? 0) + wrongThisMonthCount);
      if (minor) {
        const key = `${subject}::${minor}`;
        const entry = wrongByMinor.get(key) ?? { subject, minor, count: 0 };
        entry.count += wrongThisMonthCount;
        wrongByMinor.set(key, entry);
      }
    }

    const firstWrong = history.find((h) => !h.is_correct);
    if (firstWrong && monthKey(firstWrong.answered_at) === periodMonth) newWeaknessesDiscovered++;

    let streak = 0;
    let everMissed = false;
    for (const h of history) {
      if (!h.is_correct) {
        everMissed = true;
        streak = 0;
        continue;
      }
      streak++;
      if (everMissed && streak === REQUIRED_STREAK && monthKey(h.answered_at) === periodMonth) {
        weaknessesOvercome++;
      }
    }
  }

  return {
    periodMonth,
    answeredThisMonth,
    newWeaknessesDiscovered,
    weaknessesOvercome,
    bySubjectWrong: [...wrongBySubject.entries()]
      .map(([subject, wrongCount]) => ({ subject, wrongCount }))
      .sort((a, b) => b.wrongCount - a.wrongCount),
    byMinorWrong: [...wrongByMinor.values()]
      .map((e) => ({ subject: e.subject, minor: e.minor, wrongCount: e.count }))
      .sort((a, b) => b.wrongCount - a.wrongCount),
  };
}

export type FormatWeakness = {
  caseWrong: number;
  caseTotal: number;
  nocaseWrong: number;
  nocaseTotal: number;
  multiWrong: number;
  multiTotal: number;
  singleWrong: number;
  singleTotal: number;
};

/** 事例形式/知識形式・択一/択二という「出題形式の軸」での正誤を全期間で集計する（1カ月だけでは母数が少なすぎるため）。 */
function computeFormatWeakness(histories: Map<number, QuestionHistory>): FormatWeakness {
  const result: FormatWeakness = {
    caseWrong: 0,
    caseTotal: 0,
    nocaseWrong: 0,
    nocaseTotal: 0,
    multiWrong: 0,
    multiTotal: 0,
    singleWrong: 0,
    singleTotal: 0,
  };
  for (const { caseText, questionType, history } of histories.values()) {
    const isCase = !!(caseText && caseText.trim().length > 0);
    for (const h of history) {
      if (isCase) {
        result.caseTotal++;
        if (!h.is_correct) result.caseWrong++;
      } else {
        result.nocaseTotal++;
        if (!h.is_correct) result.nocaseWrong++;
      }
      if (questionType === "multi") {
        result.multiTotal++;
        if (!h.is_correct) result.multiWrong++;
      } else {
        result.singleTotal++;
        if (!h.is_correct) result.singleWrong++;
      }
    }
  }
  return result;
}

type RecentWrongQuestion = {
  questionId: number;
  subject: string;
  major: string | null;
  middle: string | null;
  minor: string | null;
  questionType: "single" | "multi";
  stem: string;
  caseText: string | null;
  options: string[];
  correct: number[];
  selected: number[];
  explanations: string[];
  lastWrongAt: string;
};

/** 直近の誤答から、問題ごとに最新の誤答を1件ずつ、新しい順にMISTAKE_ANALYSIS_WINDOW件抽出する。 */
function extractRecentWrongQuestions(histories: Map<number, QuestionHistory>, limit: number): RecentWrongQuestion[] {
  const entries: RecentWrongQuestion[] = [];
  for (const [questionId, q] of histories) {
    const wrongs = q.history.filter((h) => !h.is_correct);
    if (wrongs.length === 0) continue;
    const last = wrongs[wrongs.length - 1];
    entries.push({
      questionId,
      subject: q.subject,
      major: q.major,
      middle: q.middle,
      minor: q.minor,
      questionType: q.questionType,
      stem: q.stem,
      caseText: q.caseText,
      options: q.options,
      correct: q.correct,
      selected: last.selected,
      explanations: q.explanations,
      lastWrongAt: last.answered_at,
    });
  }
  entries.sort((a, b) => b.lastWrongAt.localeCompare(a.lastWrongAt));
  return entries.slice(0, limit);
}

// ---- ステージ1: 誤答パターン分析 ----

const MISTAKE_CATEGORIES = [
  "類似概念すり替え",
  "人物業績取り違え",
  "主体対象要件すり替え",
  "数値年号書き換え",
  "過度な一般化断定",
  "事例不適切対応",
  "その他",
] as const;

const MistakeAnalysisSchema = z.object({
  patterns: z
    .array(
      z.object({
        category: z.enum(MISTAKE_CATEGORIES),
        count: z.number().int().describe("この型に該当した誤答の件数"),
        exampleQuestionIds: z.array(z.number().int()),
      }),
    )
    .describe("該当が無い型は含めなくてよい"),
  fundamentalIssues: z
    .array(
      z.object({
        label: z.string().describe("例:「データ・統計系に弱い」「名称の入れ替えに弱い」など短いラベル"),
        evidence: z.string().describe("どの誤答からそう言えるかの根拠"),
        supportingQuestionIds: z.array(z.number().int()),
      }),
    )
    .max(3)
    .describe(
      "複数の誤答に共通する、本人の本質的な課題を数学的帰納法的に（個別事例→一般化）導き出したもの。" +
        "最大3件に厳選し、配列の並び順＝優先順位（1番目が最重要）にすること。多く並べるほど" +
        "要点がぼやけるため、思い切って絞り込むことを優先する",
    ),
});

function buildMistakeAnalysisPrompt(questions: RecentWrongQuestion[]): string {
  const blocks = questions
    .map((q, i) => {
      const opts = q.options.map((o, j) => `${j + 1} ${o}`).join("\n");
      return `【誤答${i + 1}】id=${q.questionId} 科目: ${q.subject}（${[q.major, q.middle, q.minor].filter(Boolean).join(" > ")}）
${q.caseText ? `事例文: ${q.caseText}\n` : ""}問題文: ${q.stem}
選択肢:\n${opts}
正答: ${q.correct.join(", ")} / 本人の解答: ${q.selected.join(", ") || "(未回答)"}
解説: ${q.explanations.join(" / ")}`;
    })
    .join("\n\n");

  return `あなたは精神保健福祉士国家試験対策アプリの学習分析officerです。以下は、ある受験者が直近に間違えた問題（最大${MISTAKE_ANALYSIS_WINDOW}件、問題ごとに直近1回分の誤答のみ）の一覧です。

# 誤答の分類方法（この6分類＋その他から選ぶ。複数該当してもよい）
① 類似概念すり替え: 同じ分野の別の概念・分類・理論の説明を、問われている対象の説明であるかのように混ぜてきた誤答を選んだ
② 人物業績取り違え: 人物と、その人が実際に行った理論・功績を取り違えた
③ 主体対象要件すり替え: 制度・法律の「誰が」「対象は誰か」「要件は何か」を取り違えた
④ 数値年号書き換え: 数字（年齢・年数・比率など）の書き換えに気づけなかった
⑤ 過度な一般化断定: 「必ず」「〜できない」等の断定的な誤答を見抜けなかった
⑥ 事例不適切対応: 事例問題で、一見丁寧だが実践的には不適切な対応を選んだ
その他: 上記に当てはまらない誤答

# 誤答一覧
${blocks}

# 依頼内容
1. 上記6分類＋その他ごとに、該当した誤答の件数と該当問題idを集計してください（該当が無い分類は出力に含めなくてよい）。
2. 個別の誤答を横断して見た時に浮かび上がる、この受験者の本質的な課題（根本的に何が苦手なのか）を、具体的な誤答から一般化する形で導き出してください。「データ・統計系の数字が絡む問題に弱い」「似た名称の制度・人物を混同しやすい」のように、具体的で実践的な指摘にしてください。根拠となった問題idも添えてください。
   **候補が多く見つかっても、最も重要・本質的なもの上位3つだけに厳選してください**（優先順位の高い順に並べる）。
   6つも7つも並べると、結局何が言いたいのか伝わらなくなります。情報量よりも「絞り込まれていて
   一目で要点がわかる」ことを優先してください。`;
}

// ---- ステージ2: 学習メンター文章生成 ----

const NarrativeSchema = z.object({
  greeting: z.string().describe("前向きな導入。今月の頑張りをまず労う"),
  highlights: z.array(z.string()).describe("良かった点。具体的な数字を交えて褒める"),
  weaknessNarrative: z.string().describe("誤答パターン分析の結果を、本人にわかりやすく噛み砕いて説明する"),
  focusAreas: z
    .array(z.string())
    .describe(
      "次月に重点的に取り組むべき科目名のみを優先順（最初が最優先）で列挙する。科目ごとの" +
        "個別の理由は書かない（出題は科目単位の一般的な練習問題であり、個々の誤答パターンを" +
        "狙い撃ちして出題できるわけではないため、科目ごとに『この誤りパターン克服のため』と" +
        "紐づけた説明はしない）。全体としての理由はfocusAreasSummaryに1つだけ書く",
    ),
  focusAreasSummary: z
    .string()
    .describe(
      "重点科目を選んだ全体的な理由を1〜2文で。出題システムは科目単位の一般的な練習問題を" +
        "生成するものであり、先月見つかった個々の誤答パターンだけを狙って出題できるわけでは" +
        "ないことを踏まえ、『量をこなす中で自然と似た誤りに触れる機会が増える』という無理のない" +
        "文脈で説明すること。過度に「この弱点が直接解消されます」と約束しないこと",
    ),
  planNarration: z
    .string()
    .describe(
      "次月の数値プラン（別途渡す）について、なぜこの量・この配分なのかを意味づけて説明する。" +
        "数値そのものは新たに考案せず、渡された数値に言及するだけにすること。出題は科目単位の" +
        "一般的な練習であり、先月の個別の誤答パターンに特化した問題だけを出せるわけではないため、" +
        "『この量をこなせば先月の弱点が直接解消される』という言い切りは避け、『まずは量を確保する" +
        "ことが土台になる』という誠実な位置づけで説明すること",
    ),
});

function buildNarrativePrompt(args: {
  metrics: MonthMetrics;
  formatWeakness: FormatWeakness;
  plan: MonthlyPlan;
  mistakeAnalysis: { patterns: unknown; fundamentalIssues: unknown };
  examDaysRemaining: number;
}): string {
  const { metrics, formatWeakness, plan, mistakeAnalysis, examDaysRemaining } = args;
  const planLines = plan.bySubject
    .filter((s) => s.reviewSets > 0 || s.practiceSets > 0)
    .map(
      (s) =>
        `- ${s.subject}: 復習${s.reviewSets * plan.setSize}問・演習${s.practiceSets * plan.setSize}問`,
    )
    .join("\n");

  return `あなたは精神保健福祉士国家試験対策アプリの「学習メンター」です。ユーザーの良かった面を具体的に褒めながら、前向きに、かつ実践的で価値の高い情報を伝える月次振り返りレポートの文章を書いてください。本番（第29回・令和9年2/6-2/7）まで残り${examDaysRemaining}日です。

# 重要な制約（誠実さのため）
このアプリの問題生成は「科目単位」で行われ、「この誤答パターン（例: 名称の入れ替えに弱い）を
狙って出題する」という個別の弱点パターンに特化した出題はできません。そのため:
- 重点科目(focusAreas)は科目名だけを優先順に挙げ、科目ごとに「この誤りパターンを克服するため」
  といった個別の理由付けはしないでください。全体としての位置づけはfocusAreasSummaryに1つだけ
  書いてください
- 次月のプラン(planNarration)も、「この問題数をこなせば先月の弱点パターンが直接解消される」とは
  言い切らず、「まず量を確保することが土台になる。その中で似た誤りに触れる機会も自然と増える」
  という誠実な位置づけで説明してください

# 今月の決定的な集計データ
- 解答数: ${metrics.answeredThisMonth}問
- 新たに発見した弱点: ${metrics.newWeaknessesDiscovered}問
- 克服した弱点: ${metrics.weaknessesOvercome}問
- 誤答が多い科目トップ5: ${metrics.bySubjectWrong.slice(0, 5).map((s) => `${s.subject}(${s.wrongCount}問)`).join("、") || "無し"}
- 誤答が多い小単元トップ5: ${metrics.byMinorWrong.slice(0, 5).map((s) => `${s.subject}/${s.minor}(${s.wrongCount}問)`).join("、") || "無し"}
- 事例問題の誤答率: ${formatWeakness.caseTotal > 0 ? Math.round((100 * formatWeakness.caseWrong) / formatWeakness.caseTotal) : 0}%（${formatWeakness.caseTotal}問中）/ 知識問題の誤答率: ${formatWeakness.nocaseTotal > 0 ? Math.round((100 * formatWeakness.nocaseWrong) / formatWeakness.nocaseTotal) : 0}%（${formatWeakness.nocaseTotal}問中）
- 五肢択二の誤答率: ${formatWeakness.multiTotal > 0 ? Math.round((100 * formatWeakness.multiWrong) / formatWeakness.multiTotal) : 0}%（${formatWeakness.multiTotal}問中）/ 五肢択一の誤答率: ${formatWeakness.singleTotal > 0 ? Math.round((100 * formatWeakness.singleWrong) / formatWeakness.singleTotal) : 0}%（${formatWeakness.singleTotal}問中）

# 今月受けた実戦模試の結果
${
  metrics.examSummary
    ? `${metrics.examSummary.roundsCount}回受験・平均得点率${metrics.examSummary.averageRate}%・合格${metrics.examSummary.passCount}回/不合格${metrics.examSummary.failCount}回${metrics.examSummary.zeroScoreGroupOccurrences > 0 ? `・0点の科目群が延べ${metrics.examSummary.zeroScoreGroupOccurrences}回発生` : ""}
得意科目トップ3: ${metrics.examSummary.topStrongSubjects.map((s) => `${s.subject}(${s.rate}%)`).join("、") || "無し"}
苦手科目トップ3: ${metrics.examSummary.topWeakSubjects.map((s) => `${s.subject}(${s.rate}%)`).join("、") || "無し"}`
    : "今月は実戦模試を受けていません"
}

# 誤答パターン分析（別のLLMが実施した結果）
${JSON.stringify(mistakeAnalysis)}

# 次月の学習プラン（数値は別のLLM呼び出しが先月の状況から配分を決め、コード側で確定させたもの。
# これ自体は変更せず、意味づけの文章だけを書くこと）
${planLines || "（対象科目無し。順調です）"}
配分を決めたLLMの考え方: ${plan.allocationRationale}

上記を踏まえ、前向きな導入・良かった点・弱点の噛み砕いた説明・重点科目（科目名の列挙＋全体理由1つ）・
プランの意味づけを書いてください。`;
}

// ---- 保存済みレポートの型 ----

export type MonthlyReportRow = {
  id: number;
  profile: string;
  period_month: string;
  generated_at: string;
  read_at: string | null;
  metrics: MonthMetrics;
  mistake_analysis: { patterns: unknown[]; fundamentalIssues: unknown[]; formatWeakness: FormatWeakness };
  plan: MonthlyPlan;
  narrative: z.infer<typeof NarrativeSchema>;
  model: string | null;
};

/**
 * 指定profile・対象月(periodMonth="YYYY-MM")の振り返りレポートを生成して保存する。
 * その profile に解答履歴が1件も無い場合は何も生成せずnullを返す（本人がまだ何も
 * 始めていない段階で空っぽのレポートを量産しないため）。
 * unique(profile, period_month) により、既に同じ月のレポートがあれば一意制約違反になる
 * ── 呼び出し側（cron）で事前に存在チェックし、冪等に扱うこと。
 */
export async function generateMonthlyReport(profile: string, periodMonth: string): Promise<{ id: number } | null> {
  const histories = await fetchFullHistory(profile);
  if (histories.size === 0) return null;

  const llm = await getLlmSettings();
  const model = getModel(llm);

  const examSummary = await fetchExamMonthSummary(profile, periodMonth);
  const metrics: MonthMetrics = { ...computeMonthMetrics(histories, periodMonth), examSummary };
  const formatWeakness = computeFormatWeakness(histories);
  const recentWrong = extractRecentWrongQuestions(histories, MISTAKE_ANALYSIS_WINDOW);

  let mistakeAnalysis: { patterns: unknown[]; fundamentalIssues: unknown[]; formatWeakness: FormatWeakness };
  if (recentWrong.length === 0) {
    mistakeAnalysis = { patterns: [], fundamentalIssues: [], formatWeakness };
  } else {
    const { object, usage } = await generateObject({
      model,
      schema: MistakeAnalysisSchema,
      prompt: buildMistakeAnalysisPrompt(recentWrong),
    });
    await logUsage({ source: "report-analyze", provider: llm.provider, model: llm.model, usage });
    mistakeAnalysis = { patterns: object.patterns, fundamentalIssues: object.fundamentalIssues, formatWeakness };
  }

  const plan = await computeMonthlyPlan(profile);
  const examDaysRemaining = daysUntilExam();

  const { object: narrative, usage: usage2 } = await generateObject({
    model,
    schema: NarrativeSchema,
    prompt: buildNarrativePrompt({ metrics, formatWeakness, plan, mistakeAnalysis, examDaysRemaining }),
  });
  await logUsage({ source: "report-write", provider: llm.provider, model: llm.model, usage: usage2 });

  const { data: inserted, error } = await supabase()
    .from("monthly_reports")
    .insert({
      profile,
      period_month: `${periodMonth}-01`,
      metrics,
      mistake_analysis: mistakeAnalysis,
      plan,
      narrative,
      model: llm.model,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: inserted.id as number };
}
