import { NextRequest, NextResponse } from "next/server";
import { ensureGeneration } from "@/lib/generationWorker";

export const maxDuration = 10;

/** 科目の問題プールを埋めるバックグラウンド生成を開始する（既に動いていれば何もしない） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const subject: string | undefined = body.subject;
    if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
    const targetPool: number = body.targetPool ?? 5;
    const llm = body.llm as { provider?: string; model?: string } | undefined;
    const status = await ensureGeneration(subject, targetPool, llm as never);
    return NextResponse.json(status);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
