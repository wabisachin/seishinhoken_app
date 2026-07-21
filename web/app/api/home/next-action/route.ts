import { NextRequest, NextResponse } from "next/server";
import { computeNextAction, type PendingResumeInfo, type RecentActionEntry } from "@/lib/nextAction";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";

export const maxDuration = 30;

const RECENT_ACTIONS: RecentActionEntry["action"][] = ["subject", "review", "mock", "exam", "garden"];
// 直近の提案履歴はホーム画面（web/app/(main)/page.tsx）がlocalStorageから渡してくる。
// クライアント発のJSONなので、形が崩れていても壊れず無視できるよう防御的に検証する
// （「同じ提案の連発を避ける」ためのソフトなヒントに過ぎず、壊れていても致命的では無い）。
const MAX_RECENT_ACTIONS = 5;
function parseRecentActions(searchParams: URLSearchParams): RecentActionEntry[] {
  const raw = searchParams.get("recentActions");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: RecentActionEntry[] = [];
    for (const entry of parsed.slice(-MAX_RECENT_ACTIONS)) {
      if (!entry || typeof entry !== "object") continue;
      const action = (entry as { action?: unknown }).action;
      if (!RECENT_ACTIONS.includes(action as RecentActionEntry["action"])) continue;
      const targetSubject = (entry as { targetSubject?: unknown }).targetSubject;
      const part = (entry as { part?: unknown }).part;
      result.push({
        action: action as RecentActionEntry["action"],
        targetSubject: typeof targetSubject === "string" ? targetSubject : null,
        part: part === "common" || part === "specialized" ? part : null,
      });
    }
    return result;
  } catch {
    return [];
  }
}

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
    const recentActions = parseRecentActions(request.nextUrl.searchParams);
    const result = await computeNextAction(profile, pendingResume, recentActions);
    return NextResponse.json(result);
  } catch (e) {
    await logError("next-action-route", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
