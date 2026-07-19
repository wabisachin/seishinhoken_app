import { NextRequest, NextResponse } from "next/server";
import { searchNavPages } from "@/lib/navSearch";
import { logError } from "@/lib/errorLog";

export const maxDuration = 30;

/** 教科書検索バナー用。ユーザーの自由入力に対する意味検索で国試ナビのページを返す。 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get("q")?.trim();
    if (!q) return NextResponse.json({ results: [] });
    const results = await searchNavPages(q, 8);
    return NextResponse.json({ results });
  } catch (e) {
    await logError("nav-search", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
