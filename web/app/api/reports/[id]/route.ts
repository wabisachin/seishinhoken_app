import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { isValidProfile } from "@/lib/profile";

/** レポート詳細。応援する人は常にprofile=selfを渡す（本人のレポートを読み取り専用で見る）。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const profile = req.nextUrl.searchParams.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });
    const { id } = await params;
    const { data, error } = await supabase()
      .from("monthly_reports")
      .select("*")
      .eq("id", Number(id))
      .eq("profile", profile)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: "report not found" }, { status: 404 });
    return NextResponse.json({ report: data });
  } catch (e) {
    await logError("reports-detail", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * 既読化。所有者(self/test)のみが呼ぶ想定 ── 応援する人が本人のレポートを開いても、
 * ここは呼ばない（応援する人の未読管理はクライアント側のlocalStorageで完結させ、
 * 本人の既読状態には一切触れない設計のため）。
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { profile } = (await req.json().catch(() => ({ profile: undefined }))) as { profile?: string };
    if (profile !== "self" && profile !== "test") {
      return NextResponse.json({ error: "profile must be 'self' or 'test'" }, { status: 400 });
    }
    const { id } = await params;
    const { error } = await supabase()
      .from("monthly_reports")
      .update({ read_at: new Date().toISOString() })
      .eq("id", Number(id))
      .eq("profile", profile);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    await logError("reports-read", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
