import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";
import { getPlanProgress } from "@/lib/monthlyPlan";

/** ダッシュボードの「今月の学習プラン」進捗カード用。ロジックはlib/monthlyPlan.ts参照。 */
export async function GET(req: NextRequest) {
  try {
    const profile = req.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const progress = await getPlanProgress(profile);
    if (!progress) return NextResponse.json({ plan: null });
    return NextResponse.json(progress);
  } catch (e) {
    await logError("reports-plan-progress", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
