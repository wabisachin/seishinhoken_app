import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/** 本人(profile='self')の科目別正答率・日次/月次推移・概況サマリを返す */
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

    // 科目別累計
    const totals = new Map<string, { attempts: number; correct: number }>();
    for (const r of rows) {
      const t = totals.get(r.subject) ?? { attempts: 0, correct: 0 };
      t.attempts += r.attempts;
      t.correct += r.correct;
      totals.set(r.subject, t);
    }
    const bySubject = [...totals.entries()]
      .map(([subject, t]) => ({
        subject,
        kind: kindMap.get(subject) ?? null,
        attempts: t.attempts,
        correct: t.correct,
        accuracy: t.attempts > 0 ? Math.round((1000 * t.correct) / t.attempts) / 10 : 0,
      }))
      .sort((a, b) => a.accuracy - b.accuracy);

    // 課程区分（共通/専門）別の集計
    const kindTotals = new Map<string, { attempts: number; correct: number }>();
    for (const s of bySubject) {
      const k = s.kind ?? "other";
      const t = kindTotals.get(k) ?? { attempts: 0, correct: 0 };
      t.attempts += s.attempts;
      t.correct += s.correct;
      kindTotals.set(k, t);
    }
    const byKind = [...kindTotals.entries()].map(([kind, t]) => ({
      kind,
      attempts: t.attempts,
      correct: t.correct,
      accuracy: t.attempts > 0 ? Math.round((1000 * t.correct) / t.attempts) / 10 : 0,
    }));

    // 日次推移
    const byDay = new Map<string, { attempts: number; correct: number }>();
    for (const r of rows) {
      const day = String(r.day).slice(0, 10);
      const t = byDay.get(day) ?? { attempts: 0, correct: 0 };
      t.attempts += r.attempts;
      t.correct += r.correct;
      byDay.set(day, t);
    }
    const timeline = [...byDay.entries()]
      .map(([day, t]) => ({
        day,
        attempts: t.attempts,
        accuracy: t.attempts > 0 ? Math.round((1000 * t.correct) / t.attempts) / 10 : 0,
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    // 月次推移（保護者が全体の伸びを見やすいように）
    const byMonth = new Map<string, { attempts: number; correct: number }>();
    for (const r of rows) {
      const month = String(r.day).slice(0, 7); // YYYY-MM
      const t = byMonth.get(month) ?? { attempts: 0, correct: 0 };
      t.attempts += r.attempts;
      t.correct += r.correct;
      byMonth.set(month, t);
    }
    const monthly = [...byMonth.entries()]
      .map(([month, t]) => ({
        month,
        attempts: t.attempts,
        accuracy: t.attempts > 0 ? Math.round((1000 * t.correct) / t.attempts) / 10 : 0,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // 概況サマリ
    const totalAttempts = rows.reduce((sum, r) => sum + r.attempts, 0);
    const totalCorrect = rows.reduce((sum, r) => sum + r.correct, 0);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);
    const recentAttempts = [...byDay.entries()]
      .filter(([day]) => day >= sevenDaysAgoStr)
      .reduce((sum, [, t]) => sum + t.attempts, 0);
    const totalSubjects = new Set((taxSubjects ?? []).map((r) => r.subject)).size;

    const summary = {
      totalAttempts,
      totalCorrect,
      overallAccuracy: totalAttempts > 0 ? Math.round((1000 * totalCorrect) / totalAttempts) / 10 : 0,
      recentAttempts,
      subjectsPracticed: bySubject.length,
      totalSubjects,
    };

    return NextResponse.json({ summary, bySubject, byKind, timeline, monthly });
  } catch (e) {
    await logError("stats", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
