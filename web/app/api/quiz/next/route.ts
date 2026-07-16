import { NextRequest, NextResponse } from "next/server";
import { getOrGenerateNext } from "@/lib/questionSupply";

export const maxDuration = 60;

/**
 * 分野別演習の「次の1問」を返す。無ければ高々1回だけその場で生成を試みる
 * （リクエスト駆動・バックグラウンドループ無し。詳細はlib/questionSupply.ts参照）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const subject: string | undefined = body.subject;
    if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
    const excludeIds: number[] = Array.isArray(body.excludeIds) ? body.excludeIds : [];
    const result = await getOrGenerateNext(subject, excludeIds);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
