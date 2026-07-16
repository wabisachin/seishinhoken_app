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
 * mode=mock:    プールがある全科目から均等に perSubject 問（既定3問）ずつ、
 *               共通課程→専門課程の順にまとめてサンプリング
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
      const perSubject = Math.min(Math.max(parseInt(params.get("perSubject") ?? "3", 10), 1), 10);

      // 科目ごとの課程区分（共通/専門）。past_questionsに載っている科目名基準。
      const { data: pastSubjects } = await sb.from("past_questions").select("subject, kind");
      const kindMap = new Map<string, string | null>();
      for (const row of pastSubjects ?? []) kindMap.set(row.subject, row.kind);

      const { data: pool, error } = await sb.from("questions").select(QUESTION_COLS).eq("status", "active");
      if (error) throw new Error(error.message);
      const bySubject = new Map<string, Question[]>();
      for (const q of (pool ?? []) as Question[]) {
        if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
        bySubject.get(q.subject)!.push(q);
      }

      // 共通課程→専門課程→その他の順に並べ、各科目のperSubject問がページ単位で
      // まとまって出るようにする（1ページ=3問なら1ページ=1科目になる）
      const kindRank = (k: string | null | undefined) => (k === "common" ? 0 : k === "specialized" ? 1 : 2);
      const subjects = [...bySubject.keys()].sort((a, b) => {
        const ra = kindRank(kindMap.get(a));
        const rb = kindRank(kindMap.get(b));
        return ra !== rb ? ra - rb : a.localeCompare(b, "ja");
      });

      const picked: Question[] = [];
      for (const subject of subjects) {
        picked.push(...shuffle(bySubject.get(subject)!).slice(0, perSubject));
      }
      return NextResponse.json({ questions: picked });
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
