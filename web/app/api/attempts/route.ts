import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/** 解答を記録する。正誤判定はサーバー側でDBのcorrectと照合して行う */
export async function POST(req: NextRequest) {
  try {
    const { question_id, selected, mode, profile } = await req.json();
    if (!question_id || !Array.isArray(selected) || !mode) {
      return NextResponse.json({ error: "question_id, selected[], mode are required" }, { status: 400 });
    }
    // 本人・保護者・テスターが同時にアプリを使っても回答履歴が混ざらないよう、
    // クライアントの自己申告区分をそのまま記録する（不明な値は自己申告なし扱い）
    const safeProfile = profile === "self" || profile === "guardian" ? profile : "self";
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
      profile: safeProfile,
    });
    if (insError) throw new Error(insError.message);

    return NextResponse.json({ is_correct: isCorrect, correct });
  } catch (e) {
    await logError("attempts", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
