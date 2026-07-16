import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { Question } from "@/lib/types";

export const maxDuration = 15;

const QUESTION_COLS =
  "id, subject, taxonomy_id, question_type, stem, case_text, options, correct, explanations, key_points, citations";

/** 指定科目からまだ見ていない（excludeに無い）active問題を1問返す。無ければquestion: null */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const subject = params.get("subject");
    if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
    const excludeParam = params.get("exclude") ?? "";
    const excludeIds = excludeParam
      .split(",")
      .map((s) => parseInt(s, 10))
      .filter((n) => !Number.isNaN(n));

    const sb = supabase();
    let query = sb.from("questions").select(QUESTION_COLS).eq("subject", subject).eq("status", "active").limit(1);
    if (excludeIds.length > 0) query = query.not("id", "in", `(${excludeIds.join(",")})`);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const question = ((data ?? [])[0] as Question | undefined) ?? null;
    return NextResponse.json({ question });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
