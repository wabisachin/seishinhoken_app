import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest, checkPassword } from "@/lib/adminAuth";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/**
 * 生成済み問題・解答履歴・進行中セッションを全削除する（検証データを消して本番運用を
 * 開始するため）。documents/chunks/taxonomy/past_questions（教科書・過去問データ）は
 * 再投入に時間がかかるため対象外とし、消さない。
 *
 * 誤操作防止のため、ログイン済みでも実行にはパスワードの再入力を必須にしている。
 */
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { password } = await req.json().catch(() => ({ password: undefined }));
    if (typeof password !== "string" || !checkPassword(password)) {
      return NextResponse.json({ error: "パスワードが違います" }, { status: 401 });
    }
    const sb = supabase();
    // attempts/quiz_sessionsはquestions削除のON DELETE CASCADEで一緒に消えるが、
    // 明示的にも消しておく（依存関係の変化に強くするため）。
    await sb.from("attempts").delete().gte("id", 0);
    await sb.from("questions").delete().gte("id", 0);
    return NextResponse.json({ ok: true });
  } catch (e) {
    await logError("admin-reset", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
