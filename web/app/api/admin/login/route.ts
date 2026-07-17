import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, checkPassword, issueToken } from "@/lib/adminAuth";

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();
    if (typeof password !== "string" || !checkPassword(password)) {
      return NextResponse.json({ error: "パスワードが違います" }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    // 30日固定だと「なぜか毎回パスワードを求められない」と感じるほど長期間ログイン状態が
    // 残ってしまうため、管理者セッションは1時間で切れるようにする。
    res.cookies.set(ADMIN_COOKIE, issueToken(), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60,
    });
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
