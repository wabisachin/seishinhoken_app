import { generateObject } from "ai";
import { z } from "zod";
import { createHash } from "crypto";
import { supabase } from "./supabase";
import { getModel } from "./llm";
import { logUsage } from "./usageLog";
import { logError } from "./errorLog";
import { getStockSnapshot, getExamReadyRounds } from "./questionSupply";
import { getWrongStockProgress, getWrongStockProgressBySubject, getGardenSummary, GARDEN_MIN_ELIGIBLE } from "./reviewStock";
import { countRoundsThisMonth, hasStartedRoundToday, computePartResult, computeVerdict, ExamAttemptRow } from "./examMode";
import {
  describeFailedGroups,
  EXAM_MONTHLY_LIMIT,
  EXAM_SUBJECT_GROUPS,
  EXAM_SUBJECT_COUNTS,
  EXAM_ROUND_LABEL,
  daysUntilExam,
  type ExamPart,
} from "./examFormat";
import { getPlanProgress } from "./monthlyPlan";

export type NextAction = {
  action: "subject" | "review" | "mock" | "exam" | "garden";
  targetSubject: string | null;
  // actionが"mock"（全科目演習）の場合のみ、共通科目/専門科目のどちらを勧めるかを持つ
  part: ExamPart | null;
  reason: string;
  href: string;
};

// ホーム画面（web/app/(main)/page.tsx）がlocalStorageから検出した「前回途中で終えた
// 演習」の情報。サーバー側のこのファイルからはlocalStorageを直接読めないため、
// クライアントからクエリパラメータ経由で渡してもらう
export type PendingResumeInfo = { kind: "mock" | "subject"; subject: string | null; part: ExamPart | null; label: string };

// ホーム画面がlocalStorageに保持している「直近の（LLMが実際に計算した）提案」の履歴。
// これも前回途中の演習と同じ理由でクライアント側にしか無いため、クエリパラメータ経由で
// 渡してもらう。専用のDBテーブルを新設せずlocalStorage経由にしているのは、この用途が
// 「同じ提案の連発を避ける」というLLMへのソフトなヒントに過ぎず、端末をまたいだ厳密な
// 一貫性までは必要としないため（対して前回途中の演習はUXの一貫性に直結するため元々
// この方式を使っている）。最新のものが配列の末尾
export type RecentActionEntry = { action: NextAction["action"]; targetSubject: string | null; part: ExamPart | null };

function partOfSubject(subject: string): ExamPart | null {
  return EXAM_SUBJECT_COUNTS.find((s) => s.subject === subject)?.part ?? null;
}

const RECENT_ACTION_LABEL: Record<RecentActionEntry["action"], string> = {
  subject: "科目別演習",
  review: "復習モード",
  mock: "全科目演習",
  exam: "実戦模試",
  garden: "想起の庭",
};

function describeRecentAction(r: RecentActionEntry): string {
  if (r.targetSubject) return `${RECENT_ACTION_LABEL[r.action]}「${r.targetSubject}」`;
  if (r.part) return `${RECENT_ACTION_LABEL[r.action]}(${r.part === "common" ? "共通" : "専門"})`;
  return RECENT_ACTION_LABEL[r.action];
}

// 科目別演習/全科目演習の裏側のストック目標(questionSupply.tsのSTOCK_TARGET=5)を下回れば
// 「薄い」とみなす目安。ちょうど同じ値だと補充中の一瞬でも毎回反応してしまうため、少し余裕を持たせる。
const STOCK_LOW_THRESHOLD = 3;
// これ未満の科目が残っていれば「まだ全体像を触れていない」とみなす目安
const UNTOUCHED_THRESHOLD = 3;
// ホーム画面の科目別弱点マップ（web/app/(main)/page.tsx）と揃えた、まだ試していない
// 問題の中に見つかっていない弱点が隠れている可能性が高いとみなす解答数の目安
// （意図的に同じ値を独立に持つ。クライアント側のpage.tsxからはサーバー専用のこの
// ファイルを直接importできないため。review-summary APIの直近件数の窓RECENT_WINDOW=30
// とも揃えている）
const CONFIDENCE_THRESHOLD = 30;
// 復習ストック（間違えたまま残っている問題）がこの問数以上溜まっている科目は、
// たとえ全体の解答数が薄くても新規問題(subject)をこれ以上勧めない（ユーザー指示:
// 復習が積み上がりすぎるとやる気を削ぐため、それ以上増やさず消化を優先させる）。
// 元は20だったが、克服条件が「3回連続正解」から「1回正解」に緩和され、同じ復習量でも
// 3倍消化しやすくなったため、しきい値も3倍(60)に引き上げている。
const REVIEW_BACKLOG_SATURATION = 60;

const NextActionSchema = z.object({
  action: z.enum(["subject", "review", "mock", "exam", "garden"]),
  targetSubject: z
    .string()
    .nullable()
    .describe("actionがsubjectまたはreviewの場合のみ、提示された候補の中から科目名を1つそのまま指定する。それ以外はnull"),
  part: z
    .enum(["common", "specialized"])
    .nullable()
    .describe("actionがmockの場合のみ、共通科目(common)/専門科目(specialized)のどちらを優先すべきか指定する。それ以外はnull"),
  reason: z.string().describe("40字以内、1文。具体的な数字を1つ含めること。決まり文句の言い換えではなく状況に即した理由にする"),
});

function href(action: NextAction["action"], targetSubject: string | null, part: ExamPart | null = null): string {
  if (action === "mock") return `/quiz?mode=mock${part ? `&part=${part}` : ""}`;
  if (action === "exam") return "/full-mock";
  if (action === "garden") return "/quiz?mode=garden";
  if (action === "review") return `/quiz?mode=review${targetSubject ? `&subject=${encodeURIComponent(targetSubject)}` : ""}`;
  return `/quiz?mode=subject${targetSubject ? `&subject=${encodeURIComponent(targetSubject)}` : ""}`;
}

/**
 * ホーム画面の「おすすめの次の一手」がLLMの判断材料にする状況一式。DB問い合わせのみで
 * 組み立てられ、LLM呼び出しは含まない（stateHashだけを安く取得できるようにするため、
 * computeNextActionと分離してある）。
 */
async function gatherState(pendingResume: PendingResumeInfo | null, profile: string) {
  const sb = supabase();
  const [
    stockSnapshot,
    wrongProgress,
    wrongBySubject,
    readyRounds,
    roundsThisMonth,
    startedToday,
    attemptedRows,
    latestExamRows,
    examAttemptDetailRows,
    gardenSummary,
    planProgress,
    latestReportRows,
  ] = await Promise.all([
    getStockSnapshot(profile),
    getWrongStockProgress(profile),
    getWrongStockProgressBySubject(profile),
    getExamReadyRounds(profile),
    countRoundsThisMonth(profile),
    hasStartedRoundToday(profile),
    sb.from("attempts").select("question_id, questions!inner(subject)").eq("profile", profile),
    sb
      .from("exam_attempts")
      .select("*")
      .eq("profile", profile)
      .eq("common_status", "completed")
      .eq("specialized_status", "completed")
      .order("created_at", { ascending: false })
      .limit(1),
    sb.from("attempts").select("is_correct, questions!inner(subject)").eq("profile", profile).eq("mode", "exam"),
    getGardenSummary(profile),
    getPlanProgress(profile),
    sb.from("monthly_reports").select("id, period_month").eq("profile", profile).order("period_month", { ascending: false }).limit(1),
  ]);

  // 「解答数」は重複の無い問題数（同じ問題を復習で何度も解き直した分は水増ししない）。
  // ホーム画面の弱点マップ・review-summary APIと同じ考え方
  const questionIdsBySubject = new Map<string, Set<number>>();
  for (const r of (attemptedRows.data ?? []) as unknown as { question_id: number; questions: { subject: string } | null }[]) {
    const subject = r.questions?.subject;
    if (!subject) continue;
    const set = questionIdsBySubject.get(subject) ?? new Set<number>();
    set.add(r.question_id);
    questionIdsBySubject.set(subject, set);
  }
  const attemptCountBySubject = new Map<string, number>(
    [...questionIdsBySubject.entries()].map(([s, set]) => [s, set.size]),
  );
  const untouchedSubjects = stockSnapshot.map((s) => s.subject).filter((s) => (attemptCountBySubject.get(s) ?? 0) === 0);
  const lowConfidenceSubjects = stockSnapshot
    .map((s) => s.subject)
    .filter((s) => {
      const c = attemptCountBySubject.get(s) ?? 0;
      return c > 0 && c < CONFIDENCE_THRESHOLD;
    });
  const thinSubjects = stockSnapshot.filter((s) => s.unserved < STOCK_LOW_THRESHOLD).map((s) => s.subject);
  const avgUnserved =
    stockSnapshot.length > 0 ? stockSnapshot.reduce((sum, s) => sum + s.unserved, 0) / stockSnapshot.length : 0;

  // ホーム画面の弱点マップ（web/app/(main)/page.tsx）と同じ「解答数が薄い」判定
  // （絶対的な最低ライン、または全科目の解答数の中央値の半分以下）。苦手科目トップ3の
  // 中で解答数が薄い科目は、復習ではなく科目別演習を勧めるべきかどうかの判定に使う
  const sortedAttemptTotals = stockSnapshot.map((s) => attemptCountBySubject.get(s.subject) ?? 0).sort((a, b) => a - b);
  const mid = Math.floor(sortedAttemptTotals.length / 2);
  const medianAttempts =
    sortedAttemptTotals.length === 0
      ? 0
      : sortedAttemptTotals.length % 2 === 0
        ? (sortedAttemptTotals[mid - 1] + sortedAttemptTotals[mid]) / 2
        : sortedAttemptTotals[mid];
  function isThinSubject(subject: string): boolean {
    const c = attemptCountBySubject.get(subject) ?? 0;
    if (c === 0) return false;
    return c < CONFIDENCE_THRESHOLD || c <= medianAttempts / 2;
  }

  const weakSubjects = [...wrongBySubject.entries()]
    .map(([subject, p]) => ({ subject, ...p, thin: isThinSubject(subject) }))
    .filter((s) => s.currentWrong > 0)
    .sort((a, b) => b.currentWrong / Math.max(1, b.everMissed) - a.currentWrong / Math.max(1, a.everMissed));

  // 判定材料は十分(CONFIDENCE_THRESHOLD問以上)だが、他の科目に比べて解答数が相対的に
  // 少ない科目。「最低限はクリアしたが、他と比べるとまだ薄い」というアプリ利用が
  // 進んだ中盤以降向けのバランス調整シグナル（未挑戦・データ不足が無くなった後の
  // 次善の選択肢として使う）。母数が少なすぎると「相対的に」の比較自体が不安定なため、
  // 判定材料が十分な科目が5科目以上ある場合のみ計算する
  const confidentTotals = stockSnapshot
    .map((s) => ({ subject: s.subject, total: attemptCountBySubject.get(s.subject) ?? 0 }))
    .filter((s) => s.total >= CONFIDENCE_THRESHOLD);
  const avgConfidentTotal =
    confidentTotals.length > 0 ? confidentTotals.reduce((sum, s) => sum + s.total, 0) / confidentTotals.length : 0;
  const underPracticedSubjects =
    confidentTotals.length >= 5
      ? confidentTotals
          .filter((s) => s.total < avgConfidentTotal * 0.6)
          .sort((a, b) => a.total - b.total)
          .map((s) => s.subject)
      : [];

  // 実戦模試（一度も出題されていない問題での本番形式）の科目別正答率。演習モードの
  // 「間違えたまま残っている問題」は復習で潰せば消えるが、実戦模試は毎回未知の問題
  // なので、ここでの正答率の低さは演習だけでは見えない「未知の問題への対応力不足」を
  // 直接示す、より強いシグナルになる。サンプルが1〜2問だとぶれが大きいため
  // 最低3問以上答えている科目だけを対象にする
  const examStatsBySubject = new Map<string, { correct: number; total: number }>();
  for (const r of (examAttemptDetailRows.data ?? []) as unknown as {
    is_correct: boolean;
    questions: { subject: string } | null;
  }[]) {
    const subject = r.questions?.subject;
    if (!subject) continue;
    const s = examStatsBySubject.get(subject) ?? { correct: 0, total: 0 };
    s.total++;
    if (r.is_correct) s.correct++;
    examStatsBySubject.set(subject, s);
  }
  const examWeakSubjects = [...examStatsBySubject.entries()]
    .map(([subject, s]) => ({ subject, accuracy: s.correct / s.total, total: s.total }))
    .filter((s) => s.total >= 3)
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 3);

  let lastExamText = "まだ受験していません";
  let weakestInFailedGroup: string | null = null;
  const latestRow = (latestExamRows.data ?? [])[0] as ExamAttemptRow | undefined;
  if (latestRow) {
    const [commonResult, specializedResult] = await Promise.all([
      computePartResult(latestRow.id, latestRow.common_question_ids ?? []),
      computePartResult(latestRow.id, latestRow.specialized_question_ids ?? []),
    ]);
    const bySubject = [...commonResult.bySubject, ...specializedResult.bySubject];
    const verdict = computeVerdict(bySubject);
    const commonAt = latestRow.common_completed_at ? new Date(latestRow.common_completed_at).getTime() : 0;
    const specializedAt = latestRow.specialized_completed_at ? new Date(latestRow.specialized_completed_at).getTime() : 0;
    const daysSince = Math.max(0, Math.floor((Date.now() - Math.max(commonAt, specializedAt)) / (1000 * 60 * 60 * 24)));

    if (verdict.failedGroups.length > 0) {
      const failedSubjects = EXAM_SUBJECT_GROUPS.filter((g) => verdict.failedGroups.includes(g.label)).flatMap(
        (g) => g.subjects,
      );
      const candidates = bySubject.filter((s) => failedSubjects.includes(s.subject));
      candidates.sort((a, b) => a.correct / Math.max(1, a.total) - b.correct / Math.max(1, b.total));
      weakestInFailedGroup = candidates[0]?.subject ?? failedSubjects[0] ?? null;
    }

    lastExamText = verdict.passed
      ? `${daysSince}日前に受験し合格ライン到達（総得点率${Math.round(verdict.overallRate * 100)}%）`
      : `${daysSince}日前に受験し不合格（0点の科目群: ${describeFailedGroups(verdict.failedGroups) || "無し"}、総得点率${Math.round(verdict.overallRate * 100)}%）`;
  }

  const remainingThisMonth = Math.max(0, EXAM_MONTHLY_LIMIT - roundsThisMonth);
  const examFeasible =
    remainingThisMonth > 0 && !startedToday && (readyRounds.common >= 1 || readyRounds.specialized >= 1);
  const knownSubjects = new Set(stockSnapshot.map((s) => s.subject));

  // 想起の庭（克服済みだが忘れかけている問題の再出題）が今すぐ選べるかどうか。
  const gardenFeasible = gardenSummary.eligibleCount >= GARDEN_MIN_ELIGIBLE;

  // 本番までの残り日数。日次で値が変わるため、これはプロンプト文脈にのみ使い
  // stateHash（フィンガープリント）には含めない ── 含めると毎日必ずLLM呼び出しが
  // 走ってしまい、「状態が変わったら再計算」という設計意図が壊れるため。
  const examDaysRemaining = daysUntilExam();

  const latestReport = (latestReportRows.data ?? [])[0] as { id: number; period_month: string } | undefined;

  // 実戦模試の月内ペース配分をLLMに判断させるための材料（月内に何日残っているか）。
  // 月5回という枠は早い者勝ちで使い切ってよいものではなく、弱点克服の節目ごとに
  // 計画的に消費すべきという方針をプロンプト側で明示する
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = daysInMonth - now.getDate();

  // 「状態が変わったら再計算」用のフィンガープリント。科目ごとのストック・解答数・弱点数と、
  // 今月の受験回数・直近の完了模試（id・完了時刻）を材料にする ── これらのどれか1つでも
  // 変われば学習状況が実質的に変わったとみなせるため、時間経過ではなく変化そのものを
  // トリガーにできる（時間で区切ると、短時間に何問も解いて最適解が変わっても反映されない
  // 問題があるため採用しない）。
  const subjects = [...stockSnapshot].sort((a, b) => a.subject.localeCompare(b.subject));
  const fingerprintParts = subjects.map((s) => {
    const wrong = wrongBySubject.get(s.subject);
    const attempts = attemptCountBySubject.get(s.subject) ?? 0;
    return `${s.subject}:${s.unserved}:${attempts}:${wrong?.currentWrong ?? 0}:${wrong?.everMissed ?? 0}`;
  });
  fingerprintParts.push(`rounds:${roundsThisMonth}`);
  fingerprintParts.push(
    `latestExam:${latestRow?.id ?? "none"}:${latestRow?.common_completed_at ?? ""}:${latestRow?.specialized_completed_at ?? ""}`,
  );
  // 前回途中で終えた演習の有無・種類もフィンガープリントに含める。DB側の状態が
  // 何も変わっていなくても、ユーザーが演習を再開して離脱した/最後まで終えたなど
  // localStorageの状態だけが変化した場合に、キャッシュされた古い提案を使い回さないため
  fingerprintParts.push(`pending:${pendingResume ? `${pendingResume.kind}:${pendingResume.subject ?? ""}:${pendingResume.part ?? ""}` : "none"}`);
  // 新しい月次振り返りレポートが発行された・想起の庭が開放/非開放に切り替わった、
  // という変化もキャッシュ再計算のトリガーに含める（本番までの残り日数のような
  // 日次で必ず変わる値はここには含めない。上のexamDaysRemainingのコメント参照）。
  fingerprintParts.push(`report:${latestReport?.id ?? "none"}:${latestReport?.period_month ?? ""}`);
  fingerprintParts.push(`garden:${gardenFeasible ? "on" : "off"}`);
  const stateHash = createHash("sha256").update(fingerprintParts.join("|")).digest("hex").slice(0, 20);

  // 科目別弱点マップ（ホーム画面）が信頼できる目安になるにはCONFIDENCE_THRESHOLD(30)問は
  // 必要、という前提を次の一手LLMにも数字そのもので見せる（要約されたリストだけでなく）。
  // 「全体的にまだ30問に届いていない科目が多い」という生の実感を持たせることで、
  // 「まずは全科目演習で母数を底上げすべき」という判断を後押しする材料にする。
  const attemptCountsForPrompt = stockSnapshot
    .map((s) => ({ subject: s.subject, count: attemptCountBySubject.get(s.subject) ?? 0 }))
    .sort((a, b) => a.count - b.count);

  return {
    stockSnapshot,
    wrongProgress,
    untouchedSubjects,
    lowConfidenceSubjects,
    thinSubjects,
    avgUnserved,
    weakSubjects,
    underPracticedSubjects,
    examWeakSubjects,
    lastExamText,
    weakestInFailedGroup,
    remainingThisMonth,
    examFeasible,
    knownSubjects,
    roundsThisMonth,
    startedToday,
    daysLeftInMonth,
    pendingResume,
    gardenSummary,
    gardenFeasible,
    planProgress,
    examDaysRemaining,
    attemptCountsForPrompt,
    stateHash,
  };
}

/** LLMを呼ばずに状態のフィンガープリントだけを安く取得する。ホーム画面がこれで前回と比較し、変化が無ければLLM呼び出し自体を省略する。 */
export async function getNextActionStateHash(profile: string, pendingResume: PendingResumeInfo | null = null): Promise<string> {
  const state = await gatherState(pendingResume, profile);
  return state.stateHash;
}

/**
 * ホーム画面の「おすすめの次の一手」用コンテキストを集計し、LLMに1つだけ行動を選ばせる。
 * 合格条件（総得点60%以上 かつ 科目群①〜⑨すべてで1問以上正解）から逆算した学習戦略
 * ──ストックが薄ければ全科目演習で広げる、苦手が見えてきたら科目別演習で潰す、
 * 一定間隔・一定の弱点克服が進んだら実戦模試で力試しする──をLLMに提示し、
 * 状況に応じた短い理由とともに選ばせる。実行不可能な選択肢（実戦模試のストック未準備・
 * 月次上限到達）はそもそも候補に含めないため、LLMがそれを選ぶことは無いが、
 * 万一のフォーマット逸脱・API失敗に備えてコード側でも検証し、決定的なフォールバックを用意する。
 */
export async function computeNextAction(
  profile: string,
  pendingResume: PendingResumeInfo | null = null,
  recentActions: RecentActionEntry[] = [],
): Promise<NextAction & { stateHash: string }> {
  const state = await gatherState(pendingResume, profile);
  const {
    stockSnapshot,
    wrongProgress,
    untouchedSubjects,
    lowConfidenceSubjects,
    thinSubjects,
    avgUnserved,
    weakSubjects,
    underPracticedSubjects,
    examWeakSubjects,
    lastExamText,
    weakestInFailedGroup,
    remainingThisMonth,
    examFeasible,
    knownSubjects,
    roundsThisMonth,
    startedToday,
    daysLeftInMonth,
    gardenSummary,
    gardenFeasible,
    planProgress,
    examDaysRemaining,
    attemptCountsForPrompt,
    stateHash,
  } = state;

  // 前回途中で終えた演習（ホーム画面のバナーで案内済み）がある場合、次の一手も
  // 必ずそれを最優先で促す。演習を投げ出して別の科目に誘導するとバナーとの言動が
  // 矛盾するため、LLMの判断結果に関わらずこれを最終的な答えとして優先する
  function pendingResumeAction(): NextAction | null {
    if (!pendingResume) return null;
    const targetSubject = pendingResume.kind === "subject" ? pendingResume.subject : null;
    const part = pendingResume.kind === "mock" ? pendingResume.part : null;
    return {
      action: pendingResume.kind,
      targetSubject,
      part,
      reason: `前回途中の${pendingResume.label}を終わらせましょう`,
      href: href(pendingResume.kind, targetSubject, part),
    };
  }

  // 前回途中で終えた演習がある場合は、LLMを呼ぶまでもなく必ずそれを最優先で促す
  // （演習を投げ出して別の科目に誘導すると、ホーム画面のバナーと言動が矛盾するため）
  const pendingAction = pendingResumeAction();
  if (pendingAction) return { ...pendingAction, stateHash };

  // 共通科目(12科目)・専門科目(6科目)のうち、演習量が相対的に手薄な方を選ぶ。
  // mockを提案する場面すべてで「どちらを勧めるか」を決めるのに使う共通ロジック
  const partStats: Record<ExamPart, { total: number; count: number }> = {
    common: { total: 0, count: 0 },
    specialized: { total: 0, count: 0 },
  };
  for (const s of attemptCountsForPrompt) {
    const p = partOfSubject(s.subject);
    if (!p) continue;
    partStats[p].total += s.count;
    partStats[p].count += 1;
  }
  const partAvg = (p: ExamPart) => (partStats[p].count > 0 ? partStats[p].total / partStats[p].count : 0);
  const weakerPart: ExamPart = partAvg("common") <= partAvg("specialized") ? "common" : "specialized";
  // 特定の科目群（未挑戦・薄いストックなど）の中で、共通/専門のどちらに多く該当するかで
  // 部分を選ぶ。同数ならweakerPart（全体の演習量で手薄な方）で決める
  function pickPart(subjects: string[]): ExamPart {
    const counts: Record<ExamPart, number> = { common: 0, specialized: 0 };
    for (const s of subjects) {
      const p = partOfSubject(s);
      if (p) counts[p]++;
    }
    if (counts.common === counts.specialized) return weakerPart;
    return counts.common > counts.specialized ? "common" : "specialized";
  }

  function fallback(): NextAction {
    if (untouchedSubjects.length + lowConfidenceSubjects.length >= UNTOUCHED_THRESHOLD) {
      if (untouchedSubjects.length > 0) {
        const part = pickPart(untouchedSubjects);
        return { action: "mock", targetSubject: null, part, reason: `まだ${untouchedSubjects.length}科目手つかずです`, href: href("mock", null, part) };
      }
      const part = pickPart(lowConfidenceSubjects);
      return {
        action: "mock",
        targetSubject: null,
        part,
        reason: `問題数が少なく判断できない科目が${lowConfidenceSubjects.length}件あります`,
        href: href("mock", null, part),
      };
    }
    if (weakestInFailedGroup) {
      return {
        action: "subject",
        targetSubject: weakestInFailedGroup,
        part: null,
        reason: `前回0点だった科目群の「${weakestInFailedGroup}」を優先しましょう`,
        href: href("subject", weakestInFailedGroup),
      };
    }
    if (examWeakSubjects.length > 0) {
      const w = examWeakSubjects[0];
      return {
        action: "subject",
        targetSubject: w.subject,
        part: null,
        reason: `実戦模試の${w.subject}正答率が${Math.round(w.accuracy * 100)}%です`,
        href: href("subject", w.subject),
      };
    }
    if (thinSubjects.length > 0) {
      // ストックが薄い科目が少数（UNTOUCHED_THRESHOLD未満）に絞り込める場合は、
      // 全科目演習で薄く触れるより、その中で最も薄い科目を直接指定した科目別演習の
      // 方が効率的（その科目を訪れること自体がストック補充のトリガーになるため）。
      // 一方、多数の科目で同時にストックが薄い場合は「特定の科目」の問題ではなく
      // 全体的・システム的な傾向とみなし、1科目に絞らず全科目演習で広く底上げする
      // （untouchedSubjects/lowConfidenceSubjectsと同じUNTOUCHED_THRESHOLDを流用）
      if (thinSubjects.length >= UNTOUCHED_THRESHOLD) {
        const part = pickPart(thinSubjects);
        return {
          action: "mock",
          targetSubject: null,
          part,
          reason: `ストックが薄い科目が${thinSubjects.length}件と広範囲です`,
          href: href("mock", null, part),
        };
      }
      const target = [...stockSnapshot].filter((s) => thinSubjects.includes(s.subject)).sort((a, b) => a.unserved - b.unserved)[0];
      return {
        action: "subject",
        targetSubject: target.subject,
        part: null,
        reason: `${target.subject}の未出題ストックが${target.unserved}問です`,
        href: href("subject", target.subject),
      };
    }
    if (gardenFeasible) {
      // 想起の庭（克服済みだが忘れかけている問題の再テスト）は、未挑戦・実戦模試の
      // 弱点・ストック不足という「まだ実力を把握できていない/整えられていない」段階の
      // 対応より優先度は下げるが、間違えたまま残っている問題をひたすら復習で潰す
      // （weakSubjects）より先に、忘れかけている既知の内容を定着させることを優先する
      return {
        action: "garden",
        targetSubject: null,
        part: null,
        reason: `想起の庭の対象が${gardenSummary.eligibleCount}問あります`,
        href: href("garden", null),
      };
    }
    if (weakSubjects.length > 0) {
      const w = weakSubjects[0];
      // 解答数が薄い科目は、間違いが残っていても復習ではなく科目別演習を勧める
      // （まだ見つかっていない弱点が多く残っている可能性が高いため）。ただし復習ストックが
      // 既にREVIEW_BACKLOG_SATURATION問以上溜まっている場合は、薄い科目であっても
      // 新規問題をこれ以上増やさず、復習で消化することを優先する
      const action = w.thin && w.currentWrong < REVIEW_BACKLOG_SATURATION ? "subject" : "review";
      return { action, targetSubject: w.subject, part: null, reason: `${w.subject}が残り${w.currentWrong}問です`, href: href(action, w.subject) };
    }
    if (underPracticedSubjects.length > 0) {
      // 未挑戦・データ不足・苦手・実戦模試弱点・想起の庭のいずれも無く、他の科目に
      // 比べて演習量が相対的に少ない科目がある局面。thinSubjectsと同じ考え方で、
      // 少数科目に絞り込める場合はその中で最も演習量が少ない科目を直接指定した方が
      // ピンポイントで底上げできる（既にCONFIDENCE_THRESHOLD問以上は解いている科目群
      // なので、ストックが即座に枯渇するリスクも低い）。多数の科目が同時に該当する
      // 場合は特定科目の問題ではないため、1科目に絞らず全科目演習で広く底上げする
      if (underPracticedSubjects.length >= UNTOUCHED_THRESHOLD) {
        const part = pickPart(underPracticedSubjects);
        return {
          action: "mock",
          targetSubject: null,
          part,
          reason: `演習量が少なめの科目が${underPracticedSubjects.length}件と広範囲です`,
          href: href("mock", null, part),
        };
      }
      const target = underPracticedSubjects[0];
      return {
        action: "subject",
        targetSubject: target,
        part: null,
        reason: `${target}の演習量が他科目より少なめです`,
        href: href("subject", target),
      };
    }
    if (examFeasible) {
      return { action: "exam", targetSubject: null, part: null, reason: "実力を試すタイミングです", href: href("exam", null) };
    }
    return { action: "mock", targetSubject: null, part: weakerPart, reason: "演習を続けましょう", href: href("mock", null, weakerPart) };
  }

  // 共通科目(12科目)・専門科目(6科目)それぞれの平均解答数。mockを選ぶ際にLLMがどちらを
  // 優先すべきか判断する材料にする（fallback()のpickPart/weakerPartと同じ考え方）
  const partAvgText = (["common", "specialized"] as const)
    .map((p) => `${p === "common" ? "共通科目" : "専門科目"}(${partStats[p].count}科目)平均${partAvg(p).toFixed(1)}問`)
    .join("、");

  const feasibleActionsText = [
    "- subject: 科目別演習（対象科目を1つ指定。新しい問題で演習する）",
    "- review: 復習モード（対象科目を1つ指定。過去に間違えて、まだ克服できていない問題だけを解き直す）",
    "- mock: 全科目演習（共通科目12科目または専門科目6科目のどちらかを1問ずつ横断。partに\"common\"か\"specialized\"を必ず指定すること。手薄な科目を広く埋める・ストックを増やす）",
    examFeasible ? "- exam: 実戦模試（本番同形式・未出題の問題だけで力試し）" : null,
    gardenFeasible ? "- garden: 想起の庭（克服済みだが2週間以上前に克服した、忘れかけている問題の再テスト）" : null,
  ]
    .filter(Boolean)
    .join("\n");

  const planLines =
    planProgress && planProgress.planTotal > 0
      ? planProgress.bySubject
          .slice(0, 8)
          .map((s) => `${s.subject}(${s.done}/${s.target}問)`)
          .join("、")
      : null;

  // 科目別弱点マップ（ホーム画面）が信頼できる目安になるにはCONFIDENCE_THRESHOLD(30)問は
  // 必要という前提を、要約済みリストだけでなく生の数字でも見せる。「まだ30問に届いていない
  // 科目がこれだけある」という実感が、mockでの底上げ判断を後押しする材料になる
  const belowThresholdCount = attemptCountsForPrompt.filter((s) => s.count < CONFIDENCE_THRESHOLD).length;
  const attemptCountsText = attemptCountsForPrompt.map((s) => `${s.subject}${s.count}問`).join("、");

  const prompt = `あなたは精神保健福祉士国家試験対策アプリの学習コーチです。
${EXAM_ROUND_LABEL}本番（あと${examDaysRemaining}日）に向け、合格条件から逆算して合格率を最大化する
学習手順を常に考えてください。合格条件は「総得点60%以上」かつ「科目群①〜⑨のすべてで
1問以上正解」で、0点の科目群が1つでもあれば総得点に関係なく不合格になります。

以下のユーザーの現在の学習状況から、次に取るべき行動を1つだけ選び、
40字以内の短い理由とともに提示してください。理由には状況を表す具体的な数字を1つ含めてください。

# 最重要ルール: subject（科目別演習）を選んでよいのは、具体的に対象科目を1つに
特定できる場合（苦手科目群・実戦模試での失点・間違えたまま残っている問題・特定科目の
ストック不足・特定科目の演習量の少なさ）だけです。「まだ判断材料が少ない」「未挑戦の
科目が多い」という、対象科目を1つに絞り込めない・全体的に判断材料が不足している
理由でsubjectを選んではいけません。その場合は必ずmock（全科目演習）を選んでください。
mockは12科目/6科目に1問ずつ出題が分散するため、どこかしらの科目に在庫がある確率が
高く、ユーザーを待たせずに母数を増やせます。
なお「特定科目のストックが薄い」「特定科目の演習量が少ない」場合にsubjectを選ぶのは、
「母数を増やしたい」の一種ではなく、その科目を直接指定すること自体がストック補充の
トリガーになるという積極的な狙いがあるためです（1科目の未出題ストックは常時5問程度
しか無いため、その科目を訪れればすぐ生成が走ります）。これは「まだよくわからないので
手広く触れたい」という消極的なmockの理由とは区別してください。

ただし、これは絶対のルールではなく「毎回判で押したように同じ提案ばかりでユーザーが
飽きてしまう」ことも避けたい重要な観点です。上記の条件に当てはまる場面でも、時には
気分転換として別の科目の科目別演習や復習モードを提案して構いません（学習メンターとして
硬直的になりすぎないこと）。

# 直近の提案履歴（古い→新しい。実際にLLMが計算した回のみ、キャッシュ再利用は含まない）
${recentActions.length > 0 ? recentActions.map((r) => describeRecentAction(r)).join("、") : "まだありません"}
同じ提案（同じaction・同じ対象科目）が複数回連続している場合、その根拠となっている状況
（0点科目群・実戦模試の弱点など）がまだ解消されていないこと自体は正当な理由になり得ますが、
それでも判で押したように同じ提案を続けるとユーザーが飽きてしまい、結局その弱点への対策も
進みません。0点科目群のような最優先シグナルであっても例外ではありません。3回以上連続して
いれば、根本の状況（0点科目群など）を解消する別の切り口（例: 同じ科目群内でも対象科目を
変える、subjectではなくreviewやgardenを挟む、mockで底上げするなど）に一度切り替えてください

# 科目別の解答数（弱点マップが信頼できる目安になるにはCONFIDENCE_THRESHOLD問=30問が目安）
${attemptCountsText || "データ無し"}
→ 全${attemptCountsForPrompt.length}科目中${belowThresholdCount}科目がまだ30問未満です。この数が多いほど、
「まだ全体の判断材料が不足している」という状況が裏付けられるため、mockでの底上げを優先する
判断を強めてください。

# 共通科目/専門科目別の平均解答数（mockを選ぶ場合にpartをどちらにすべきかの判断材料）
${partAvgText}
mockを選ぶ場合、原則として平均解答数が少ない方のpartを指定してください。ただし上記の
「まだ一度も演習していない科目」「問題数が少なく判断できない科目」「ストックが薄い科目」の
一覧に特定のpartの科目が偏って多く含まれている場合は、そちらを優先してください。

# 選べる行動（このリストにあるものだけから選ぶこと）
${feasibleActionsText}
${gardenSummary.eligibleCount < GARDEN_MIN_ELIGIBLE ? `- 想起の庭は対象問題が${gardenSummary.eligibleCount}/${GARDEN_MIN_ELIGIBLE}問のため今はまだ選べません（候補に入れないでください）` : ""}

# 今月の学習プラン（振り返りレポートが算出した、合格から逆算した今月の数値目標。現在の消化状況）
${planLines ? `${planLines}（進捗 ${planProgress?.doneTotal ?? 0}/${planProgress?.planTotal ?? 0}問）` : "まだ発行されていません"}
このプランを基本の軸としつつ、より緊急の具体的な弱点シグナル（苦手科目群・実戦模試の弱点など）が
下記に出ている場合や、実際の進捗がプランから大きく外れている場合は、プランに固執せずその場の
シグナルを優先して構いません。

# 現在の状況（以下は優先度の高い順に並んでいます。上のシグナルほど優先して対応してください）
- 全${stockSnapshot.length}科目中、まだ一度も演習していない科目: ${untouchedSubjects.length}科目${untouchedSubjects.length > 0 ? `（${untouchedSubjects.slice(0, 6).join("、")}）` : ""}
- 問題数が少なく（${CONFIDENCE_THRESHOLD}問未満）苦手かどうかまだ判断できない科目: ${lowConfidenceSubjects.length}科目${lowConfidenceSubjects.length > 0 ? `（${lowConfidenceSubjects.slice(0, 6).join("、")}）` : ""}
- 問題数が少なく判断できない科目は、間違いの有無に関わらず未挑戦の科目と同列に最優先で
  扱ってください。まだ解いていない問題の中に見つかっていない弱点が隠れている可能性が
  高く、母数を増やすこと自体が優先課題です（対象を1つに絞れないためaction=mock）
- 前回の実戦模試で0点だった科目群（下の「前回の実戦模試」欄に詳細）があれば、その中で
  最も正答率が低い科目を最優先でsubjectに指定してください（合格基準に直結するため）
- 実戦模試（一度も出題されていない問題での本番形式）での科目別正答率が低い科目トップ3:
  ${examWeakSubjects.length > 0 ? examWeakSubjects.map((s) => `${s.subject}(正答率${Math.round(s.accuracy * 100)}%・${s.total}問中)`).join("、") : "実戦模試のデータがまだ十分にありません"}
- 実戦模試での正答率の低さは、演習で「間違えたまま残っている問題」が無くなっていても
  「未知の問題への対応力が低い」ことを示す強いシグナルです。0点科目群への対応が済んで
  いれば、優先的にその科目のsubjectを勧めてください
- 科目別の新規ストック（未出題の問題数）: 平均${avgUnserved.toFixed(1)}問/科目。特に少ない科目: ${thinSubjects.length > 0 ? thinSubjects.join("、") : "無し"}
  （特に少ない科目が1〜2件程度に絞り込める場合は、その中で最もストックが少ない1科目を
  subjectで直接指定してください。その科目を訪れること自体がストック補充のトリガーに
  なります。一方、特に少ない科目が${UNTOUCHED_THRESHOLD}件以上と広範囲に及ぶ場合は、
  特定科目の問題ではなく全体的な傾向とみなし、1科目に絞らずmockで広く底上げしてください）
- 想起の庭（克服済みだが2週間以上前に克服し忘れかけている問題の再テスト）: ${
    gardenFeasible
      ? `対象${gardenSummary.eligibleCount}問、前回実施は${gardenSummary.lastPlayedAt ? new Date(gardenSummary.lastPlayedAt).toLocaleDateString("ja-JP") : "未実施"}`
      : `対象${gardenSummary.eligibleCount}/${GARDEN_MIN_ELIGIBLE}問でまだ選べません`
  }
- 想起の庭の優先度: 未挑戦・実戦模試の弱点・ストック不足のいずれも無く対象問題がある場合は、
  積極的にgardenを提案してください。忘れかけている既知の内容を定着させる価値は、
  下の「間違えたまま残っている問題をひたすら復習で潰す」ことより優先度が高いです。
  ただし毎回連続で提案すると単調になるため、直近で実施済みなら他の選択肢を優先しても構いません
- 今も間違えたまま残っている問題: 全体で${wrongProgress.currentWrong}問（これまで間違えた${wrongProgress.everMissed}問中）
- 苦手科目トップ3（演習中、間違えたまま残っている問題が多い順）: ${weakSubjects.length > 0 ? weakSubjects.slice(0, 3).map((s) => `${s.subject}(残り${s.currentWrong}問${s.thin ? "・問題数少" : ""})`).join("、") : "無し"}
- 苦手科目トップ3の対応方法: 問題数が「少」と付いている科目は、間違いが残っていても
  actionはreviewではなくsubjectにしてください（母数を増やしてまだ見つかっていない
  弱点を洗い出すことを優先すべきため）。「少」が付いていない科目はactionをreviewに
  してください（問題数は十分なので、残っている間違いをそのまま復習で潰すべきため）。
  ただし、「少」が付いている科目でも復習ストック（残り◯問）が既に${REVIEW_BACKLOG_SATURATION}問
  以上溜まっている場合は例外で、actionはsubjectではなくreviewにしてください
  （復習が積み上がりすぎるとユーザーのやる気を削ぐため、これ以上新規問題を増やさず
  既存の復習ストックを消化することを優先する）
- 判定材料は十分(${CONFIDENCE_THRESHOLD}問以上)だが、他の科目に比べて問題数が相対的に
  少ない科目: ${underPracticedSubjects.length > 0 ? underPracticedSubjects.slice(0, 5).join("、") : "無し"}
  （未挑戦・データ不足・苦手科目・実戦模試での弱点・想起の庭のいずれも無い場合が対象。
  該当科目が1〜2件程度に絞り込めるなら、その中で最も演習量が少ない1科目をsubjectで
  直接指定してください（既に${CONFIDENCE_THRESHOLD}問以上解いている科目群なのでストック
  枯渇のリスクは低い）。該当科目が${UNTOUCHED_THRESHOLD}件以上と広範囲に及ぶ場合は、
  特定科目の問題ではないため1科目に絞らずmockで広く底上げしてください）
- 前回の実戦模試: ${lastExamText}
- 実戦模試: ${examFeasible ? `受験可能（今月すでに${roundsThisMonth}回受験、残り${remainingThisMonth}回。今月はあと${daysLeftInMonth}日）` : startedToday ? "今日は既に新しい回を開始済み（1日1回まで。明日また受験可能）" : "現在は受験不可（問題ストック準備中、または今月の受験上限に到達）"}
- 実戦模試は月5回までの限られた回数です。早い者勝ちで消費してよいものではなく、弱点克服が
  ある程度進んだ節目ごとに計画的に受けるのが望ましいペースです。今月すでに何度も受験している、
  もしくは前回受験からまだ日が浅い場合は、残り回数があっても演習（科目別演習・全科目演習）を
  優先し、実戦模試は勧めないでください`;

  try {
    // 次の一手は「構造化済みの状況からアクションを1つ選ぶ」だけの軽い判断であり、
    // 呼び出し回数も多い割に問題生成ほどの精度は求められないため、管理者設定の主モデル
    // （品質重視で選ばれていることが多い）とは別に、固定の低コストモデルを使う。
    // admin設定を経由させないのは、このためだけに新しい管理設定を追加するほどの
    // 複雑さに見合わないため（変更したくなったら、ここの定数を直接変えればよい）。
    const llm = { provider: "openai" as const, model: "gpt-5.6-luna" };
    const model = getModel(llm);
    const { object, usage } = await generateObject({ model, schema: NextActionSchema, prompt });
    await logUsage({ source: "next-action", provider: llm.provider, model: llm.model, usage });

    if (object.action === "exam" && !examFeasible) return { ...fallback(), stateHash };
    if (object.action === "garden" && !gardenFeasible) return { ...fallback(), stateHash };
    if (object.action === "subject" || object.action === "review") {
      if (!object.targetSubject || !knownSubjects.has(object.targetSubject)) return { ...fallback(), stateHash };
      return {
        action: object.action,
        targetSubject: object.targetSubject,
        part: null,
        reason: object.reason,
        href: href(object.action, object.targetSubject),
        stateHash,
      };
    }
    if (object.action === "mock") {
      if (object.part !== "common" && object.part !== "specialized") return { ...fallback(), stateHash };
      return { action: "mock", targetSubject: null, part: object.part, reason: object.reason, href: href("mock", null, object.part), stateHash };
    }
    return { action: object.action, targetSubject: null, part: null, reason: object.reason, href: href(object.action, null), stateHash };
  } catch (e) {
    await logError("next-action", e);
    return { ...fallback(), stateHash };
  }
}
