import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

type Bucket = { attempts: number; correct: number };
function accuracyOf(t: Bucket): number {
  return t.attempts > 0 ? Math.round((1000 * t.correct) / t.attempts) / 10 : 0;
}
function addTo(map: Map<string, Bucket>, key: string, attempts: number, correct: number) {
  const t = map.get(key) ?? { attempts: 0, correct: 0 };
  t.attempts += attempts;
  t.correct += correct;
  map.set(key, t);
}

/**
 * 本人(profile='self')の成績を返す。試験対策としては「今どの位置にいるか」が
 * 重要で、全期間の累積値はさほど意味を持たないため、当月のデータを主役にし、
 * 月ごとの推移（全体・科目別）を副次情報として添える。
 */
export async function GET() {
  try {
    const sb = supabase();
    const [{ data, error }, { data: taxSubjects }, { data: pastSubjects }] = await Promise.all([
      sb.from("subject_stats").select("subject, day, attempts, correct").eq("profile", "self").order("day", { ascending: true }),
      sb.from("taxonomy").select("subject"),
      sb.from("past_questions").select("subject, kind"),
    ]);
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const kindMap = new Map<string, string | null>();
    for (const r of pastSubjects ?? []) kindMap.set(r.subject, r.kind);

    const now = new Date();
    const thisMonth = now.toISOString().slice(0, 7);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = lastMonthDate.toISOString().slice(0, 7);

    // 月ごと・科目ごとの内訳（当月データ・科目別推移テーブルの両方の元になる）
    const bySubjectMonthMap = new Map<string, Bucket>(); // key: `${month}|${subject}`
    const byMonthMap = new Map<string, Bucket>();
    for (const r of rows) {
      const month = String(r.day).slice(0, 7);
      addTo(bySubjectMonthMap, `${month}|${r.subject}`, r.attempts, r.correct);
      addTo(byMonthMap, month, r.attempts, r.correct);
    }

    const bySubjectMonthly = [...bySubjectMonthMap.entries()]
      .map(([key, t]) => {
        const [month, subject] = key.split("|");
        return { month, subject, attempts: t.attempts, correct: t.correct, accuracy: accuracyOf(t) };
      })
      .sort((a, b) => a.month.localeCompare(b.month) || a.subject.localeCompare(b.subject, "ja"));

    const monthly = [...byMonthMap.entries()]
      .map(([month, t]) => ({ month, attempts: t.attempts, correct: t.correct, accuracy: accuracyOf(t) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // 当月の科目別集計
    const thisMonthSubjectTotals = new Map<string, Bucket>();
    for (const r of bySubjectMonthly) {
      if (r.month !== thisMonth) continue;
      addTo(thisMonthSubjectTotals, r.subject, r.attempts, r.correct);
    }
    const bySubjectThisMonth = [...thisMonthSubjectTotals.entries()]
      .map(([subject, t]) => ({
        subject,
        kind: kindMap.get(subject) ?? null,
        attempts: t.attempts,
        correct: t.correct,
        accuracy: accuracyOf(t),
      }))
      .sort((a, b) => a.accuracy - b.accuracy);

    // 当月の課程区分（共通/専門）別集計
    const thisMonthKindTotals = new Map<string, Bucket>();
    for (const s of bySubjectThisMonth) {
      addTo(thisMonthKindTotals, s.kind ?? "other", s.attempts, s.correct);
    }
    const byKindThisMonth = [...thisMonthKindTotals.entries()].map(([kind, t]) => ({
      kind,
      attempts: t.attempts,
      correct: t.correct,
      accuracy: accuracyOf(t),
    }));

    // 概況サマリ：当月 vs 前月
    const thisMonthTotal = byMonthMap.get(thisMonth) ?? { attempts: 0, correct: 0 };
    const lastMonthTotal = byMonthMap.get(lastMonth) ?? { attempts: 0, correct: 0 };
    const thisMonthAccuracy = accuracyOf(thisMonthTotal);
    const lastMonthAccuracy = accuracyOf(lastMonthTotal);
    const totalSubjects = new Set((taxSubjects ?? []).map((r) => r.subject)).size;
    const allTimeSubjectsPracticed = new Set(rows.map((r) => r.subject)).size;

    const summary = {
      thisMonth,
      thisMonthAttempts: thisMonthTotal.attempts,
      thisMonthAccuracy,
      lastMonthAttempts: lastMonthTotal.attempts,
      lastMonthAccuracy,
      deltaVsLastMonth: lastMonthTotal.attempts > 0 ? Math.round((thisMonthAccuracy - lastMonthAccuracy) * 10) / 10 : null,
      subjectsPracticed: allTimeSubjectsPracticed,
      totalSubjects,
    };

    return NextResponse.json({ summary, bySubjectThisMonth, byKindThisMonth, monthly, bySubjectMonthly });
  } catch (e) {
    await logError("stats", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
