import { NextRequest, NextResponse, after } from "next/server";
import { isAdminRequest, checkPassword } from "@/lib/adminAuth";
import { resetUnservedQuestions, topUpAllSubjects, topUpExamPool } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";

// 削除後の全科目再生成をafter()側で走らせるため、この関数のタイムアウトを延ばしておく
export const maxDuration = 300;
// maxDurationより確実に短い時間で自発的に打ち切る（他のtopupフックと同じ理由）
const RESET_TOPUP_TIME_BUDGET_MS = 270_000;

/**
 * モデル/プロンプト変更時用。まだ誰にも出題していない問題（active・rejected、attempts無し）
 * だけを削除する（解答済みの問題・履歴は一切触らない）。削除後は管理者の操作とは非同期に
 * （after()、レスポンス返却後）全科目のストックをゼロから再構築し始める。1回のリクエストで
 * 完了しなかった分は、1日1回のCron（/api/cron/topup）や通常の出題フックが後を引き継ぐ。
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
    const { deleted } = await resetUnservedQuestions();
    // resetUnservedQuestionsは通常プール・実戦模試プールの両方から未出題分を削除するため、
    // 再構築も両方行う
    after(() => topUpAllSubjects().catch((e) => logError("reset-unserved-topup", e)));
    after(() =>
      topUpExamPool({ timeBudgetMs: RESET_TOPUP_TIME_BUDGET_MS }).catch((e) => logError("reset-unserved-exam-topup", e)),
    );
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    await logError("admin-reset-unserved", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
