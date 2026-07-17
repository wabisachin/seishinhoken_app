import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { Question } from "@/lib/types";
import { logError } from "@/lib/errorLog";

export const maxDuration = 60;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const QUESTION_COLS =
  "id, subject, taxonomy_id, question_type, stem, case_text, options, correct, explanations, key_points, citations";

/**
 * 出題セットを返す。
 * mode=subject: 指定科目からランダム
 * mode=review:  最後の解答が誤答だった問題を優先
 *
 * mode=mockはここには無い。ミニ模試も分野別演習と同じ生成ロジック
 * （questionSupply.tsのgetOrGenerateNext）を使うため、MockQuiz.tsxから
 * /api/subjects で科目一覧を取り、/api/quiz/next を科目ごとに直接呼んでいる。
 */
export async function GET(req: NextRequest) {
  try {
    const sb = supabase();
    const params = req.nextUrl.searchParams;
    const mode = params.get("mode") ?? "subject";
    const count = Math.min(parseInt(params.get("count") ?? "10", 10), 50);

    if (mode === "subject") {
      const subject = params.get("subject");
      if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
      const { data, error } = await sb
        .from("questions")
        .select(QUESTION_COLS)
        .eq("subject", subject)
        .eq("status", "active");
      if (error) throw new Error(error.message);
      return NextResponse.json({ questions: shuffle(data as Question[]).slice(0, count) });
    }

    if (mode === "review") {
      // 全attemptsを新しい順に取得し、問題ごとの最新解答が誤答のものを対象にする。
      // 本人(profile='self')の解答だけを対象にし、応援する人の解答は無視する
      const { data: attempts, error } = await sb
        .from("attempts")
        .select("question_id, is_correct, answered_at")
        .eq("profile", "self")
        .order("answered_at", { ascending: false });
      if (error) throw new Error(error.message);
      const latest = new Map<number, boolean>();
      const wrongCount = new Map<number, number>();
      for (const a of attempts ?? []) {
        if (!latest.has(a.question_id)) latest.set(a.question_id, a.is_correct);
        if (!a.is_correct) wrongCount.set(a.question_id, (wrongCount.get(a.question_id) ?? 0) + 1);
      }
      const wrongIds = [...latest.entries()].filter(([, ok]) => !ok).map(([id]) => id);
      if (wrongIds.length === 0) return NextResponse.json({ questions: [] });

      // 科目は問わず全間違い問題からランダムに選ぶ。ただし固定の上位N件を毎回
      // 出すのではなく、間違えた回数が多い問題ほど選ばれやすい重み付き抽選にする
      // （そうしないと「もう一度」しても常に同じ問題・同じ並びになってしまう）
      const remaining = wrongIds.map((id) => ({ id, weight: wrongCount.get(id) ?? 1 }));
      const targetIds: number[] = [];
      const n = Math.min(count, remaining.length);
      for (let i = 0; i < n; i++) {
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
        targetIds.push(remaining[idx].id);
        remaining.splice(idx, 1);
      }

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
