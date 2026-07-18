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

    const { data, error: qError } = await sb.from("questions").select(QUESTION_COLS).in("id", ids);
    if (qError) throw new Error(qError.message);
    const byId = new Map(((data ?? []) as Question[]).map((q) => [q.id, q]));
    // 出題順（保存されたquestion_idsの並び）を維持して返す
    const questions = ids.map((id) => byId.get(id)).filter((q): q is Question => Boolean(q));
    return NextResponse.json({ questions });
  } catch (e) {
    await logError("exam-questions", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
