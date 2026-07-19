import { NextRequest, NextResponse } from "next/server";
import { computeNextAction, type PendingResumeInfo } from "@/lib/nextAction";
import { logError } from "@/lib/errorLog";

export const maxDuration = 30;

function parsePendingResume(searchParams: URLSearchParams): PendingResumeInfo | null {
  const kind = searchParams.get("pendingKind");
  const label = searchParams.get("pendingLabel");
  if ((kind !== "mock" && kind !== "subject") || !label) return null;
  return { kind, subject: searchParams.get("pendingSubject"), label };
}

/** ホーム画面の「おすすめの次の一手」。ロジックはlib/nextAction.ts参照。 */
export async function GET(request: NextRequest) {
  try {
    const pendingResume = parsePendingResume(request.nextUrl.searchParams);
    const result = await computeNextAction(pendingResume);
    return NextResponse.json(result);
  } catch (e) {
    await logError("next-action-route", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
