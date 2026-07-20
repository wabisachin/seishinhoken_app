import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";

/** 振り返りレポートの一覧（成績ページ末尾用）。応援する人は常にprofile=selfを渡す。 */
export async function GET(req: NextRequest) {
  try {
    const profile = req.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const { data, error } = await supabase()
      .from("monthly_reports")
      .select("id, period_month, generated_at, read_at, metrics")
      .eq("profile", profile)
      .order("period_month", { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ reports: data ?? [] });
  } catch (e) {
    await logError("reports-list", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
