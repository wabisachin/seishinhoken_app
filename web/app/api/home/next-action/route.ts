import { NextRequest, NextResponse } from "next/server";
import { computeNextAction, type PendingResumeInfo } from "@/lib/nextAction";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";

export const maxDuration = 30;

function parsePendingResume(searchParams: URLSearchParams): PendingResumeInfo | null {
  const kind = searchParams.get("pendingKind");
  const label = searchParams.get("pendingLabel");
  if ((kind !== "mock" && kind !== "subject") || !label) return null;
  const rawPart = searchParams.get("pendingPart");
  const part = rawPart === "common" || rawPart === "specialized" ? rawPart : null;
  return { kind, subject: searchParams.get("pendingSubject"), part, label };
}

/** ホーム画面の「おすすめの次の一手」。ロジックはlib/nextAction.ts参照。 */
export async function GET(request: NextRequest) {
  try {
    const profile = request.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const pendingResume = parsePendingResume(request.nextUrl.searchParams);
    const result = await computeNextAction(profile, pendingResume);
    return NextResponse.json(result);
  } catch (e) {
    await logError("next-action-route", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
