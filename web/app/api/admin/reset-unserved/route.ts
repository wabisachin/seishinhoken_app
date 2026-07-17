import { NextRequest, NextResponse, after } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import { resetUnservedQuestions, topUpAllSubjects } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";

// 削除後の全科目再生成をafter()側で走らせるため、この関数のタイムアウトを延ばしておく
export const maxDuration = 300;

/**
 * モデル/プロンプト変更時用。まだ誰にも出題していない問題（active・rejected、attempts無し）
 * だけを削除する（解答済みの問題・履歴は一切触らない）。削除後は管理者の操作とは非同期に
 * （after()、レスポンス返却後）全科目のストックをゼロから再構築し始める。1回のリクエストで
 * 完了しなかった分は、1日1回のCron（/api/cron/topup）や通常の出題フックが後を引き継ぐ。
 */
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { deleted } = await resetUnservedQuestions();
    after(() => topUpAllSubjects().catch((e) => logError("reset-unserved-topup", e)));
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    await logError("admin-reset-unserved", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
