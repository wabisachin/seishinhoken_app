import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/**
 * SupabaseのFreeプランは7日間アクセスが無いとプロジェクトが自動休止する。
 * 個人利用で数日〜1週間以上アプリを開かないことは普通にあるため、
 * Vercel Cron（1日1回、無料枠内）からこのエンドポイントを叩いて軽くDBに
 * アクセスし続けることで休止を防ぐ。課金・生成は一切発生しない単純な参照のみ。
 */
export async function GET() {
  try {
    const { error } = await supabase().from("taxonomy").select("id").limit(1);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, checkedAt: new Date().toISOString() });
  } catch (e) {
    await logError("cron-keepalive", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
