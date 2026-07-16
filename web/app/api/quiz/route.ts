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
 * mode=mock:    全科目から本番配分（過去問の科目別問題数比）でサンプリング
 * mode=review:  最後の解答が誤答だった問題を優先
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

    if (mode === "mock") {
      // 本番配分: 過去問の科目別問題数を重みに使う
      const { data: pastSubjects } = await sb.from("past_questions").select("subject");
      const weights = new Map<string, number>();
      for (const row of pastSubjects ?? []) {
        weights.set(row.subject, (weights.get(row.subject) ?? 0) + 1);
      }
      const { data: pool, error } = await sb
        .from("questions")
        .select(QUESTION_COLS)
        .eq("status", "active");
      if (error) throw new Error(error.message);
      const bySubject = new Map<string, Question[]>();
      for (const q of (pool ?? []) as Question[]) {
        if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
        bySubject.get(q.subject)!.push(q);
      }
      const totalWeight = [...weights.entries()]
        .filter(([s]) => bySubject.has(s))
        .reduce((acc, [, w]) => acc + w, 0);
      const picked: Question[] = [];
      for (const [subject, qs] of bySubject) {
        const w = weights.get(subject) ?? 1;
        const n = Math.max(1, Math.round((count * w) / Math.max(totalWeight, 1)));
        picked.push(...shuffle(qs).slice(0, n));
      }
      return NextResponse.json({ questions: shuffle(picked).slice(0, count) });
    }

    if (mode === "review") {
      // 全attemptsを新しい順に取得し、問題ごとの最新解答が誤答のものを対象にする
      const { data: attempts, error } = await sb
        .from("attempts")
        .select("question_id, is_correct, answered_at")
        .order("answered_at", { ascending: false });
      if (error) throw new Error(error.message);
      const latest = new Map<number, boolean>();
      const wrongCount = new Map<number, number>();
      for (const a of attempts ?? []) {
        if (!latest.has(a.question_id)) latest.set(a.question_id, a.is_correct);
        if (!a.is_correct) wrongCount.set(a.question_id, (wrongCount.get(a.question_id) ?? 0) + 1);
      }
      const targetIds = [...latest.entries()]
        .filter(([, ok]) => !ok)
        .map(([id]) => id)
        .sort((a, b) => (wrongCount.get(b) ?? 0) - (wrongCount.get(a) ?? 0))
        .slice(0, count);
      if (targetIds.length === 0) return NextResponse.json({ questions: [] });
      const { data, error: qError } = await sb
        .from("questions")
        .select(QUESTION_COLS)
        .in("id", targetIds)
        .eq("status", "active");
      if (qError) throw new Error(qError.message);
      const order = new Map(targetIds.map((id, i) => [id, i]));
      const sorted = (data as Question[]).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return NextResponse.json({ questions: sorted });
    }

    return NextResponse.json({ error: `unknown mode: ${mode}` }, { status: 400 });
  } catch (e) {
    await logError("quiz", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
