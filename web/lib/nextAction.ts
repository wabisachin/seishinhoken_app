import { generateObject } from "ai";
import { z } from "zod";
import { supabase } from "./supabase";
import { getModel } from "./llm";
import { getLlmSettings } from "./appSettings";
import { logUsage } from "./usageLog";
import { logError } from "./errorLog";
import { getStockSnapshot, getExamReadyRounds } from "./questionSupply";
import { getWrongStockProgress, getWrongStockProgressBySubject } from "./reviewStock";
import { countRoundsThisMonth, computePartResult, computeVerdict, ExamAttemptRow } from "./examMode";
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
 * ホーム画面の「おすすめの次の一手」用コンテキストを集計し、LLMに1つだけ行動を選ばせる。
 * 合格条件（総得点60%以上 かつ 科目群①〜⑨すべてで1問以上正解）から逆算した学習戦略
 * ──ストックが薄ければ全科目演習で広げる、苦手が見えてきたら科目別演習で潰す、
 * 一定間隔・一定の弱点克服が進んだら実戦模試で力試しする──をLLMに提示し、
 * 状況に応じた短い理由とともに選ばせる。実行不可能な選択肢（実戦模試のストック未準備・
 * 月次上限到達）はそもそも候補に含めないため、LLMがそれを選ぶことは無いが、
 * 万一のフォーマット逸脱・API失敗に備えてコード側でも検証し、決定的なフォールバックを用意する。
 */
export async function computeNextAction(): Promise<NextAction> {
  const sb = supabase();
  const [stockSnapshot, wrongProgress, wrongBySubject, readyRounds, roundsThisMonth, attemptedRows, latestExamRows] =
    await Promise.all([
      getStockSnapshot(),
      getWrongStockProgress(),
      getWrongStockProgressBySubject(),
      getExamReadyRounds(),
      countRoundsThisMonth("self"),
      sb.from("attempts").select("questions!inner(subject)").eq("profile", "self"),
      sb
        .from("exam_attempts")
        .select("*")
        .eq("profile", "self")
        .eq("common_status", "completed")
        .eq("specialized_status", "completed")
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

  const attemptedSubjects = new Set(
    ((attemptedRows.data ?? []) as unknown as { questions: { subject: string } | null }[])
      .map((r) => r.questions?.subject)
      .filter((s): s is string => !!s),
  );
  const untouchedSubjects = stockSnapshot.map((s) => s.subject).filter((s) => !attemptedSubjects.has(s));
  const thinSubjects = stockSnapshot.filter((s) => s.unserved < STOCK_LOW_THRESHOLD).map((s) => s.subject);
  const avgUnserved =
    stockSnapshot.length > 0 ? stockSnapshot.reduce((sum, s) => sum + s.unserved, 0) / stockSnapshot.length : 0;

  const weakSubjects = [...wrongBySubject.entries()]
    .map(([subject, p]) => ({ subject, ...p }))
    .filter((s) => s.currentWrong > 0)
    .sort((a, b) => b.currentWrong / Math.max(1, b.everMissed) - a.currentWrong / Math.max(1, a.everMissed));

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
  const examFeasible = remainingThisMonth > 0 && (readyRounds.common >= 1 || readyRounds.specialized >= 1);
  const knownSubjects = new Set(stockSnapshot.map((s) => s.subject));

  function fallback(): NextAction {
    if (untouchedSubjects.length >= UNTOUCHED_THRESHOLD) {
      return { action: "mock", targetSubject: null, reason: `まだ${untouchedSubjects.length}科目手つかずです`, href: href("mock", null) };
    }
    if (weakestInFailedGroup) {
      return {
        action: "subject",
        targetSubject: weakestInFailedGroup,
        reason: `前回0点だった科目群の「${weakestInFailedGroup}」を優先しましょう`,
        href: href("subject", weakestInFailedGroup),
      };
    }
    if (thinSubjects.length > 0) {
      return { action: "mock", targetSubject: null, reason: `ストックが薄い科目が${thinSubjects.length}件あります`, href: href("mock", null) };
    }
    if (weakSubjects.length > 0) {
      const w = weakSubjects[0];
      return { action: "subject", targetSubject: w.subject, reason: `${w.subject}が残り${w.currentWrong}問です`, href: href("subject", w.subject) };
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
- 科目別の新規ストック（未出題の問題数）: 平均${avgUnserved.toFixed(1)}問/科目。特に少ない科目: ${thinSubjects.length > 0 ? thinSubjects.join("、") : "無し"}
- 今も間違えたまま残っている問題: 全体で${wrongProgress.currentWrong}問（これまで間違えた${wrongProgress.everMissed}問中）
- 苦手科目トップ3（残り問題が多い順）: ${weakSubjects.length > 0 ? weakSubjects.slice(0, 3).map((s) => `${s.subject}(残り${s.currentWrong}問)`).join("、") : "無し"}
- 前回の実戦模試: ${lastExamText}
- 実戦模試: ${examFeasible ? `受験可能（今月あと${remainingThisMonth}回）` : "現在は受験不可（問題ストック準備中、または今月の受験上限に到達）"}`;

  try {
    const llm = await getLlmSettings();
    const model = getModel(llm);
    const { object, usage } = await generateObject({ model, schema: NextActionSchema, prompt });
    await logUsage({ source: "next-action", provider: llm.provider, model: llm.model, usage });

    if (object.action === "exam" && !examFeasible) return fallback();
    if (object.action === "subject") {
      if (!object.targetSubject || !knownSubjects.has(object.targetSubject)) return fallback();
      return { action: "subject", targetSubject: object.targetSubject, reason: object.reason, href: href("subject", object.targetSubject) };
    }
    return { action: object.action, targetSubject: null, reason: object.reason, href: href(object.action, null) };
  } catch (e) {
    await logError("next-action", e);
    return fallback();
  }
}
