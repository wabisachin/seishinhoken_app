import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/** 解答を記録する。正誤判定はサーバー側でDBのcorrectと照合して行う */
export async function POST(req: NextRequest) {
  try {
    const { question_id, selected, mode } = await req.json();
    if (!question_id || !Array.isArray(selected) || !mode) {
      return NextResponse.json({ error: "question_id, selected[], mode are required" }, { status: 400 });
    }
    const sb = supabase();
    const { data: q, error } = await sb
      .from("questions")
      .select("correct")
      .eq("id", question_id)
      .single();
    if (error || !q) return NextResponse.json({ error: "question not found" }, { status: 404 });

    const correct = (q.correct as number[]).slice().sort();
    const chosen = (selected as number[]).slice().sort();
    const isCorrect = correct.length === chosen.length && correct.every((v, i) => v === chosen[i]);

    const { error: insError } = await sb.from("attempts").insert({
      question_id,
      selected: chosen,
      is_correct: isCorrect,
      mode,
    });
    if (insError) throw new Error(insError.message);

    return NextResponse.json({ is_correct: isCorrect, correct });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
