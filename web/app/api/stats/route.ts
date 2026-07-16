import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/** 科目別の累計正答率と日次推移を返す */
export async function GET() {
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from("subject_stats")
      .select("subject, day, attempts, correct")
      .order("day", { ascending: true });
    if (error) throw new Error(error.message);

    const rows = data ?? [];
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
        attempts: t.attempts,
        correct: t.correct,
        accuracy: t.attempts > 0 ? Math.round((1000 * t.correct) / t.attempts) / 10 : 0,
      }))
      .sort((a, b) => a.accuracy - b.accuracy);

    // 全体の日次推移
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

    return NextResponse.json({ bySubject, timeline });
  } catch (e) {
    await logError("stats", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
