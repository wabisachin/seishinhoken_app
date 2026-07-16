import { NextRequest, NextResponse } from "next/server";
import { getJobStatus } from "@/lib/generationWorker";

export const maxDuration = 10;

/** 科目の生成ジョブ状態とプール件数を返す（ポーリング用、副作用なし） */
export async function GET(req: NextRequest) {
  try {
    const subject = req.nextUrl.searchParams.get("subject");
    if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
    const status = await getJobStatus(subject);
    return NextResponse.json(status);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
