import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { Question } from "@/lib/types";
import { logError } from "@/lib/errorLog";
import { computeWrongStock, computeGardenEligible } from "@/lib/reviewStock";
import { isValidProfile } from "@/lib/profile";

export const maxDuration = 60;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 重み付き・重複無しのランダム抽選でn件のidを選ぶ（review/gardenで共用）。
 * 固定の上位N件を毎回出すのではなく、weightが大きいものほど選ばれやすくすることで
 * 「もう一度」しても常に同じ問題・同じ並びにならないようにする。
 */
function weightedPickIds(entries: { id: number; weight: number }[], n: number): number[] {
  const remaining = [...entries];
  const picked: number[] = [];
  const count = Math.min(n, remaining.length);
  for (let i = 0; i < count; i++) {
    const total = remaining.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * total;
    let idx = remaining.length - 1;
    for (let j = 0; j < remaining.length; j++) {
      r -= remaining[j].weight;
      if (r <= 0) {
        idx = j;
        break;
      }
    }
    picked.push(remaining[idx].id);
    remaining.splice(idx, 1);
  }
  return picked;
}

const QUESTION_COLS =
  "id, subject, taxonomy_id, question_type, stem, case_text, options, correct, explanations, key_points, citations";

/**
 * 出題セットを返す。
 * mode=subject: 指定科目からランダム
 * mode=review:  最後の解答が誤答だった問題を優先
 * mode=garden:  記憶の庭。克服済みだが忘れかけている問題を再出題する
 *
 * mode=mockはここには無い。全科目演習も科目別演習と同じ生成ロジック
 * （questionSupply.tsのgetOrGenerateNext）を使うため、AllSubjectsQuiz.tsxから
 * /api/subjects で科目一覧を取り、/api/quiz/next を科目ごとに直接呼んでいる。
 */
export async function GET(req: NextRequest) {
  try {
    const sb = supabase();
    const params = req.nextUrl.searchParams;
    const mode = params.get("mode") ?? "subject";
    const count = Math.min(parseInt(params.get("count") ?? "10", 10), 50);
    const profile = params.get("profile");
    if (!isValidProfile(profile)) return NextResponse.json({ error: "profile is required" }, { status: 400 });

    if (mode === "subject") {
      const subject = params.get("subject");
      if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
      const { data, error } = await sb
        .from("questions")
        .select(QUESTION_COLS)
        .eq("subject", subject)
        .eq("status", "active")
        .eq("profile", profile);
      if (error) throw new Error(error.message);
      return NextResponse.json({ questions: shuffle(data as Question[]).slice(0, count) });
    }

    if (mode === "review") {
      // 弱点ストック（一度でも間違えたことがあり、直近3問連続正解で卒業していない問題）を対象にする。
      // アクティブなprofile（本人／動作テスト用）の解答だけを対象にし、応援する人の解答は無視する
      const reviewSubject = params.get("subject"); // 未指定 or "all" なら全科目対象
      const wrongStock = await computeWrongStock(profile);
      let entries = [...wrongStock.entries()];
      if (reviewSubject && reviewSubject !== "all") {
        entries = entries.filter(([, e]) => e.subject === reviewSubject);
      }
      if (entries.length === 0) return NextResponse.json({ questions: [] });

      // 科目は問わず全弱点ストックからランダムに選ぶ。間違えた回数が多い問題ほど
      // 選ばれやすい重み付き抽選にする。
      const targetIds = weightedPickIds(
        entries.map(([id, e]) => ({ id, weight: e.missCount })),
        count,
      );

      const { data, error: qError } = await sb
        .from("questions")
        .select(QUESTION_COLS)
        .in("id", targetIds)
        .eq("status", "active");
      if (qError) throw new Error(qError.message);
      return NextResponse.json({ questions: shuffle(data as Question[]) });
    }

    if (mode === "garden") {
      // 記憶の庭: 克服済み(3回連続正解済み)だが、克服してから一定期間(30日)以上
      // 経過した問題を再出題する。新規生成は一切トリガーしない（既存問題のみ）。
      // 「克服が古い問題ほど」「元々間違えた回数が多かった問題ほど」選ばれやすいよう、
      // 両者を掛け合わせた重みで抽選する（web/lib/reviewStock.ts参照）。
      const eligible = await computeGardenEligible(profile);
      const targetIds = weightedPickIds(
        [...eligible.entries()].map(([id, e]) => ({ id, weight: e.daysSinceOvercome * Math.max(1, e.missCount) })),
        count,
      );
      if (targetIds.length === 0) return NextResponse.json({ questions: [] });

      const { data, error: qError } = await sb
        .from("questions")
        .select(QUESTION_COLS)
        .in("id", targetIds)
        .eq("status", "active");
      if (qError) throw new Error(qError.message);
      return NextResponse.json({ questions: shuffle(data as Question[]) });
    }

    return NextResponse.json({ error: `unknown mode: ${mode}` }, { status: 400 });
  } catch (e) {
    await logError("quiz", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
