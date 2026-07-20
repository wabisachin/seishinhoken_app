import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";

/**
 * 新着ポップアップ用。所有者(self/test)は最新レポートのread_atで未読判定する。
 * 応援する人(profile=self指定＋クライアント側でguardian由来と分かっている)の未読管理は
 * サーバー側では行わない ── 最新レポートのidだけ返し、既読済みかどうかはクライアントの
 * localStorageで判定させる（応援する人が開いても本人の既読状態を変えたくないため）。
 */
export async function GET(req: NextRequest) {
  try {
    const profile = req.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const { data, error } = await supabase()
      .from("monthly_reports")
      .select("id, period_month, read_at")
      .eq("profile", profile)
      .order("period_month", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ hasUnread: false, reportId: null, periodMonth: null });
    return NextResponse.json({
      hasUnread: data.read_at === null,
      reportId: data.id,
      periodMonth: data.period_month,
    });
  } catch (e) {
    await logError("reports-unread", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
