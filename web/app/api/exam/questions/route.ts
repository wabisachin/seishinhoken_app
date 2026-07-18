import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import type { Question } from "@/lib/types";
import { ExamAttemptRow } from "@/lib/examMode";
import { ExamPart } from "@/lib/examFormat";

const QUESTION_COLS =
  "id, subject, taxonomy_id, question_type, stem, case_text, options, correct, explanations, key_points, citations";

/**
 * 実戦模試の出題本体（問題文・選択肢等）を返す。受験中はpartを指定してそのパートの
 * 出題順のまま返し、結果詳細画面ではpartを省略して両パート分をまとめて返す。
 */
export async function GET(req: NextRequest) {
  try {
    const examAttemptId = Number(req.nextUrl.searchParams.get("examAttemptId"));
    const part = req.nextUrl.searchParams.get("part") as ExamPart | null;
    if (!examAttemptId) return NextResponse.json({ error: "examAttemptId is required" }, { status: 400 });

    const sb = supabase();
    const { data: row, error } = await sb.from("exam_attempts").select("*").eq("id", examAttemptId).single();
    if (error || !row) return NextResponse.json({ error: "exam attempt not found" }, { status: 404 });
    const typedRow = row as ExamAttemptRow;

    const ids =
      part === "common"
        ? (typedRow.common_question_ids ?? [])
        : part === "specialized"
          ? (typedRow.specialized_question_ids ?? [])
          : [...(typedRow.common_question_ids ?? []), ...(typedRow.specialized_question_ids ?? [])];
    if (ids.length === 0) return NextResponse.json({ questions: [] });

    const [{ data, error: qError }, { data: attempts }] = await Promise.all([
      sb.from("questions").select(QUESTION_COLS).in("id", ids),
      sb
        .from("attempts")
        .select("question_id, selected, is_correct, answered_at")
        .eq("exam_attempt_id", examAttemptId)
        .in("question_id", ids)
        .order("answered_at", { ascending: false }),
    ]);
    if (qError) throw new Error(qError.message);
    const byId = new Map(((data ?? []) as Question[]).map((q) => [q.id, q]));
    // 同じ問題に複数attemptsがあれば最新のものを採用（通常は1問1回のみのはず）
    const answerByQuestion = new Map<number, { selected: number[]; isCorrect: boolean }>();
    for (const a of attempts ?? []) {
      if (!answerByQuestion.has(a.question_id)) {
        answerByQuestion.set(a.question_id, { selected: a.selected as number[], isCorrect: a.is_correct as boolean });
      }
    }
    // 出題順（保存されたquestion_idsの並び）を維持して返す。yourAnswerは結果詳細画面用
    // （そのexam_attempt内での解答。まだ解答していない設問はnull）
    const questions = ids
      .map((id) => byId.get(id))
      .filter((q): q is Question => Boolean(q))
      .map((q) => ({ ...q, yourAnswer: answerByQuestion.get(q.id) ?? null }));
    return NextResponse.json({ questions });
  } catch (e) {
    await logError("exam-questions", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
