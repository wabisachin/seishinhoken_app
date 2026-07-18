import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";
import { EXAM_TIME_LIMIT_SECONDS, ExamPart } from "@/lib/examFormat";

/**
 * サーバー側のタイムスタンプから残り秒数を計算して返す。クライアントのタイマーは
 * これで補正する（リロードしても正しい残り時間を維持するため、クライアント単独の
 * カウントダウンだけに頼らない）。
 */
export async function GET(req: NextRequest) {
  try {
    const examAttemptId = Number(req.nextUrl.searchParams.get("examAttemptId"));
    const part = req.nextUrl.searchParams.get("part") as ExamPart | null;
    if (!examAttemptId || (part !== "common" && part !== "specialized")) {
      return NextResponse.json({ error: "examAttemptId, part are required" }, { status: 400 });
    }
    const sb = supabase();
    const { data: row, error } = await sb.from("exam_attempts").select("*").eq("id", examAttemptId).single();
    if (error || !row) return NextResponse.json({ error: "exam attempt not found" }, { status: 404 });

    const isCommon = part === "common";
    const status = isCommon ? row.common_status : row.specialized_status;
    const startedAt = isCommon ? row.common_started_at : row.specialized_started_at;

    if (status === "completed") return NextResponse.json({ status, remainingSeconds: 0 });
    if (status !== "in_progress" || !startedAt) {
      return NextResponse.json({ error: "このパートはまだ開始されていません" }, { status: 400 });
    }
    const elapsedMs = Date.now() - new Date(startedAt).getTime();
    const remainingSeconds = Math.max(0, EXAM_TIME_LIMIT_SECONDS[part] - Math.floor(elapsedMs / 1000));
    return NextResponse.json({ status, remainingSeconds });
  } catch (e) {
    await logError("exam-status", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
