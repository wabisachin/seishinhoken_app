import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getNavPageImageUrl } from "@/lib/navStorage";
import { logError } from "@/lib/errorLog";

/** 国試ナビのページ画像を表示するための短命の署名付きURLを発行する。 */
export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

    const { data, error } = await supabase()
      .from("nav_pages")
      .select("id, book, page_number, title, image_path")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: "見つかりません" }, { status: 404 });

    const url = await getNavPageImageUrl(data.image_path);
    return NextResponse.json({ ...data, url });
  } catch (e) {
    await logError("nav-page", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
