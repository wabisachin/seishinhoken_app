import { NextRequest, NextResponse } from "next/server";
import { generateOneQuestion } from "@/lib/generation";

export const maxDuration = 300;

/** 1問生成する（クライアント側で必要数ぶんループ呼び出しする） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const subject: string | undefined = body.subject;
    if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
    const llm = body.llm as { provider?: string; model?: string } | undefined;
    const result = await generateOneQuestion(subject, llm as never);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
