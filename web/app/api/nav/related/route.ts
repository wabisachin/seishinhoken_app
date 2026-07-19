import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { searchNavPages } from "@/lib/navSearch";
import { logError } from "@/lib/errorLog";

// この値未満の類似度は「関連ページ無し」として扱う。国試ナビは2冊684ページしか
// カバーしていないため、無関係な問題でも一番近いページがそれなりの類似度を
// 持ってしまうことがある。低い閾値だと的外れな関連付けが増えるため、ある程度
// 高めに設定している。実データで様子を見て調整する前提の暫定値
const RELEVANCE_THRESHOLD = 0.5;

/**
 * 解説画面用。問題ごとに一致した国試ナビのページをlazy-computeしてquestions行に
 * キャッシュする（毎回embedding検索するとコストがかかる上、既存の生成済み問題
 * 20000件超に対して事前バッチ処理する必要も無くなる）。
 * DBへの書き込み（初回チェック時のキャッシュ確定）を伴うため、意図せず何度も
 * 叩かれると困る先読み等を避けてPOSTにしている。
 */
export async function POST(request: NextRequest) {
  try {
    const { questionId } = await request.json();
    if (!questionId) return NextResponse.json({ error: "questionIdが必要です" }, { status: 400 });

    const sb = supabase();
    const { data: question, error: qError } = await sb
      .from("questions")
      .select("id, stem, subject, nav_page_id, nav_page_checked")
      .eq("id", questionId)
      .maybeSingle();
    if (qError) throw new Error(qError.message);
    if (!question) return NextResponse.json({ error: "問題が見つかりません" }, { status: 404 });

    if (question.nav_page_checked) {
      if (!question.nav_page_id) return NextResponse.json({ navPage: null });
      const { data: page } = await sb
        .from("nav_pages")
        .select("id, book, page_number, title")
        .eq("id", question.nav_page_id)
        .maybeSingle();
      return NextResponse.json({ navPage: page ?? null });
    }

    const matches = await searchNavPages(`${question.subject} ${question.stem}`, 1);
    const top = matches[0];
    const matched = top && top.similarity >= RELEVANCE_THRESHOLD ? top : null;

    await sb.from("questions").update({ nav_page_id: matched?.id ?? null, nav_page_checked: true }).eq("id", questionId);

    return NextResponse.json({
      navPage: matched ? { id: matched.id, book: matched.book, page_number: matched.page_number, title: matched.title } : null,
    });
  } catch (e) {
    await logError("nav-related", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
