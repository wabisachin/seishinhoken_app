import { generateObject } from "ai";
import { z } from "zod";
import { createHash } from "crypto";
import { supabase } from "./supabase";
import { getModel } from "./llm";
import { getLlmSettings } from "./appSettings";
import { logUsage } from "./usageLog";
import { logError } from "./errorLog";
import { getStockSnapshot, getExamReadyRounds } from "./questionSupply";
import { getWrongStockProgress, getWrongStockProgressBySubject } from "./reviewStock";
import { countRoundsThisMonth, hasStartedRoundToday, computePartResult, computeVerdict, ExamAttemptRow } from "./examMode";
import { EXAM_MONTHLY_LIMIT, EXAM_SUBJECT_GROUPS } from "./examFormat";

export type NextAction = {
  action: "subject" | "mock" | "exam";
  targetSubject: string | null;
  reason: string;
  href: string;
};

// 科目別演習/全科目演習の裏側のストック目標(questionSupply.tsのSTOCK_TARGET=5)を下回れば
// 「薄い」とみなす目安。ちょうど同じ値だと補充中の一瞬でも毎回反応してしまうため、少し余裕を持たせる。
const STOCK_LOW_THRESHOLD = 3;
// これ未満の科目が残っていれば「まだ全体像を触れていない」とみなす目安
const UNTOUCHED_THRESHOLD = 3;
// ホーム画面の科目別弱点マップ（web/app/(main)/page.tsx）と揃えた、正答率・克服判定の
// 信頼性が低いとみなす解答数の目安（意図的に同じ値を独立に持つ。クライアント側の
// page.tsxからはサーバー専用のこのファイルを直接importできないため。review-summary APIの
// 直近件数の窓RECENT_WINDOW=30とも揃えている）
const CONFIDENCE_THRESHOLD = 30;

const NextActionSchema = z.object({
  action: z.enum(["subject", "mock", "exam"]),
  targetSubject: z
    .string()
    .nullable()
    .describe("actionがsubjectの場合のみ、提示された候補の中から科目名を1つそのまま指定する。それ以外はnull"),
  reason: z.string().describe("40字以内、1文。具体的な数字を1つ含めること。決まり文句の言い換えではなく状況に即した理由にする"),
});

function href(action: NextAction["action"], targetSubject: string | null): string {
  if (action === "mock") return "/quiz?mode=mock";
  if (action === "exam") return "/full-mock";
  return `/quiz?mode=subject${targetSubject ? `&subject=${encodeURIComponent(targetSubject)}` : ""}`;
}

/**
 * ホーム画面の「おすすめの次の一手」がLLMの判断材料にする状況一式。DB問い合わせのみで
 * 組み立てられ、LLM呼び出しは含まない（stateHashだけを安く取得できるようにするため、
 * computeNextActionと分離してある）。
 */
async function gatherState() {
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
  ] = await Promise.all([
    getStockSnapshot(),
    getWrongStockProgress(),
    getWrongStockProgressBySubject(),
    getExamReadyRounds(),
    countRoundsThisMonth("self"),
    hasStartedRoundToday("self"),
    sb.from("attempts").select("questions!inner(subject)").eq("profile", "self"),
    sb
      .from("exam_attempts")
      .select("*")
      .eq("profile", "self")
      .eq("common_status", "completed")
      .eq("specialized_status", "completed")
      .order("created_at", { ascending: false })
      .limit(1),
    sb.from("attempts").select("is_correct, questions!inner(subject)").eq("profile", "self").eq("mode", "exam"),
  ]);

  const attemptCountBySubject = new Map<string, number>();
  for (const r of (attemptedRows.data ?? []) as unknown as { questions: { subject: string } | null }[]) {
    const subject = r.questions?.subject;
    if (!subject) continue;
    attemptCountBySubject.set(subject, (attemptCountBySubject.get(subject) ?? 0) + 1);
  }
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

  const weakSubjects = [...wrongBySubject.entries()]
    .map(([subject, p]) => ({ subject, ...p }))
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
      : `${daysSince}日前に受験し不合格（0点の科目群: ${verdict.failedGroups.join("、") || "無し"}、総得点率${Math.round(verdict.overallRate * 100)}%）`;
  }

  const remainingThisMonth = Math.max(0, EXAM_MONTHLY_LIMIT - roundsThisMonth);
  const examFeasible =
    remainingThisMonth > 0 && !startedToday && (readyRounds.common >= 1 || readyRounds.specialized >= 1);
  const knownSubjects = new Set(stockSnapshot.map((s) => s.subject));

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
  const stateHash = createHash("sha256").update(fingerprintParts.join("|")).digest("hex").slice(0, 20);

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
    stateHash,
  };
}

/** LLMを呼ばずに状態のフィンガープリントだけを安く取得する。ホーム画面がこれで前回と比較し、変化が無ければLLM呼び出し自体を省略する。 */
export async function getNextActionStateHash(): Promise<string> {
  const state = await gatherState();
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
export async function computeNextAction(): Promise<NextAction & { stateHash: string }> {
  const state = await gatherState();
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
    stateHash,
  } = state;

  function fallback(): NextAction {
    if (untouchedSubjects.length + lowConfidenceSubjects.length >= UNTOUCHED_THRESHOLD) {
      if (untouchedSubjects.length > 0) {
        return { action: "mock", targetSubject: null, reason: `まだ${untouchedSubjects.length}科目手つかずです`, href: href("mock", null) };
      }
      return {
        action: "mock",
        targetSubject: null,
        reason: `解答数が少なく判断できない科目が${lowConfidenceSubjects.length}件あります`,
        href: href("mock", null),
      };
    }
    if (weakestInFailedGroup) {
      return {
        action: "subject",
        targetSubject: weakestInFailedGroup,
        reason: `前回0点だった科目群の「${weakestInFailedGroup}」を優先しましょう`,
        href: href("subject", weakestInFailedGroup),
      };
    }
    if (examWeakSubjects.length > 0) {
      const w = examWeakSubjects[0];
      return {
        action: "subject",
        targetSubject: w.subject,
        reason: `実戦模試の${w.subject}正答率が${Math.round(w.accuracy * 100)}%です`,
        href: href("subject", w.subject),
      };
    }
    if (thinSubjects.length > 0) {
      return { action: "mock", targetSubject: null, reason: `ストックが薄い科目が${thinSubjects.length}件あります`, href: href("mock", null) };
    }
    if (weakSubjects.length > 0) {
      const w = weakSubjects[0];
      return { action: "subject", targetSubject: w.subject, reason: `${w.subject}が残り${w.currentWrong}問です`, href: href("subject", w.subject) };
    }
    if (underPracticedSubjects.length > 0) {
      const subject = underPracticedSubjects[0];
      return {
        action: "subject",
        targetSubject: subject,
        reason: `${subject}は他科目より解答数が少なめです`,
        href: href("subject", subject),
      };
    }
    if (examFeasible) {
      return { action: "exam", targetSubject: null, reason: "実力を試すタイミングです", href: href("exam", null) };
    }
    return { action: "mock", targetSubject: null, reason: "演習を続けましょう", href: href("mock", null) };
  }

  const feasibleActionsText = [
    "- subject: 科目別演習（対象科目を1つ指定。苦手科目を重点的に潰す）",
    "- mock: 全科目演習（全科目を1問ずつ横断。手薄な科目を広く埋める・ストックを増やす）",
    examFeasible ? "- exam: 実戦模試（本番同形式・未出題の問題だけで力試し）" : null,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `あなたは精神保健福祉士国家試験対策アプリの学習コーチです。
合格条件は「総得点60%以上」かつ「科目群①〜⑨のすべてで1問以上正解」で、
0点の科目群が1つでもあれば総得点に関係なく不合格になります。

以下のユーザーの現在の学習状況から、次に取るべき行動を1つだけ選び、
40字以内の短い理由とともに提示してください。理由には状況を表す具体的な数字を1つ含めてください。

# 選べる行動（このリストにあるものだけから選ぶこと）
${feasibleActionsText}

# 現在の状況
- 全${stockSnapshot.length}科目中、まだ一度も演習していない科目: ${untouchedSubjects.length}科目${untouchedSubjects.length > 0 ? `（${untouchedSubjects.slice(0, 6).join("、")}）` : ""}
- 解答数が少なく（${CONFIDENCE_THRESHOLD}問未満）苦手かどうかまだ判断できない科目: ${lowConfidenceSubjects.length}科目${lowConfidenceSubjects.length > 0 ? `（${lowConfidenceSubjects.slice(0, 6).join("、")}）` : ""}
- 科目別の新規ストック（未出題の問題数）: 平均${avgUnserved.toFixed(1)}問/科目。特に少ない科目: ${thinSubjects.length > 0 ? thinSubjects.join("、") : "無し"}
- 今も間違えたまま残っている問題: 全体で${wrongProgress.currentWrong}問（これまで間違えた${wrongProgress.everMissed}問中）
- 苦手科目トップ3（演習中、間違えたまま残っている問題が多い順）: ${weakSubjects.length > 0 ? weakSubjects.slice(0, 3).map((s) => `${s.subject}(残り${s.currentWrong}問)`).join("、") : "無し"}
- 解答数が少なく判断できない科目は、間違いの有無に関わらず未挑戦の科目と同列に最優先で
  扱ってください。解答数が少ないうちに「苦手」と決めつけるのは判定として不安定です
  （数問間違えた直後に3問連続正解しただけで「克服」判定されるなど、サンプルが少なすぎて
  信頼できないため）。苦手科目トップ3への対応は、判断できない科目が無くなった後にしてください
- 実戦模試（一度も出題されていない問題での本番形式）での科目別正答率が低い科目トップ3:
  ${examWeakSubjects.length > 0 ? examWeakSubjects.map((s) => `${s.subject}(正答率${Math.round(s.accuracy * 100)}%・${s.total}問中)`).join("、") : "実戦模試のデータがまだ十分にありません"}
- 実戦模試での正答率の低さは、演習で「間違えたまま残っている問題」が無くなっていても
  「未知の問題への対応力が低い」ことを示す強いシグナルです。苦手科目トップ3が無い、または
  対応済みでも、実戦模試での弱点科目が残っていれば優先的に科目別演習を勧めてください
- 判定材料は十分(${CONFIDENCE_THRESHOLD}問以上)だが、他の科目に比べて解答数が相対的に
  少ない科目: ${underPracticedSubjects.length > 0 ? underPracticedSubjects.slice(0, 5).join("、") : "無し"}
  （未挑戦・データ不足・苦手科目・実戦模試での弱点のいずれも無い場合、この中から1科目を
  選んでバランスよく演習量を底上げする提案をしてください）
- 前回の実戦模試: ${lastExamText}
- 実戦模試: ${examFeasible ? `受験可能（今月すでに${roundsThisMonth}回受験、残り${remainingThisMonth}回。今月はあと${daysLeftInMonth}日）` : startedToday ? "今日は既に新しい回を開始済み（1日1回まで。明日また受験可能）" : "現在は受験不可（問題ストック準備中、または今月の受験上限に到達）"}
- 実戦模試は月5回までの限られた回数です。早い者勝ちで消費してよいものではなく、弱点克服が
  ある程度進んだ節目ごとに計画的に受けるのが望ましいペースです。今月すでに何度も受験している、
  もしくは前回受験からまだ日が浅い場合は、残り回数があっても演習（科目別演習・全科目演習）を
  優先し、実戦模試は勧めないでください`;

  try {
    const llm = await getLlmSettings();
    const model = getModel(llm);
    const { object, usage } = await generateObject({ model, schema: NextActionSchema, prompt });
    await logUsage({ source: "next-action", provider: llm.provider, model: llm.model, usage });

    if (object.action === "exam" && !examFeasible) return { ...fallback(), stateHash };
    if (object.action === "subject") {
      if (!object.targetSubject || !knownSubjects.has(object.targetSubject)) return { ...fallback(), stateHash };
      return {
        action: "subject",
        targetSubject: object.targetSubject,
        reason: object.reason,
        href: href("subject", object.targetSubject),
        stateHash,
      };
    }
    return { action: object.action, targetSubject: null, reason: object.reason, href: href(object.action, null), stateHash };
  } catch (e) {
    await logError("next-action", e);
    return { ...fallback(), stateHash };
  }
}
