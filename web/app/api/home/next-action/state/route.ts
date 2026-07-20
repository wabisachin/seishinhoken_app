import { NextRequest, NextResponse } from "next/server";
import { getNextActionStateHash, type PendingResumeInfo } from "@/lib/nextAction";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";

function parsePendingResume(searchParams: URLSearchParams): PendingResumeInfo | null {
  const kind = searchParams.get("pendingKind");
  const label = searchParams.get("pendingLabel");
  if ((kind !== "mock" && kind !== "subject") || !label) return null;
  const rawPart = searchParams.get("pendingPart");
  const part = rawPart === "common" || rawPart === "specialized" ? rawPart : null;
  return { kind, subject: searchParams.get("pendingSubject"), part, label };
}

/**
 * 「おすすめの次の一手」の判断材料（弱点ストック・ストック量・受験履歴・前回途中で
 * 終えた演習の有無など）が前回から変化したかどうかだけを、LLMを呼ばずに安く返す。
 * ホーム画面はこれを前回のstateHashと比較し、一致すればキャッシュ済みの結果をそのまま
 * 使い、不一致の場合だけ/api/home/next-action（LLM呼び出しあり）を叩く。
 */
export async function GET(request: NextRequest) {
  try {
    const profile = request.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const pendingResume = parsePendingResume(request.nextUrl.searchParams);
    const stateHash = await getNextActionStateHash(profile, pendingResume);
    return NextResponse.json({ stateHash });
  } catch (e) {
    await logError("next-action-state-route", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
