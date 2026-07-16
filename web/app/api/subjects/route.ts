import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logError } from "@/lib/errorLog";

/** 科目一覧と、科目ごとの生成済み問題数・タクソノミー項目数を返す */
export async function GET() {
  try {
    const sb = supabase();
    const [{ data: tax }, { data: qs }, { data: past }] = await Promise.all([
      sb.from("taxonomy").select("subject"),
      sb.from("questions").select("subject").eq("status", "active"),
      sb.from("past_questions").select("subject, kind"),
    ]);

    const taxCount = new Map<string, number>();
    for (const r of tax ?? []) taxCount.set(r.subject, (taxCount.get(r.subject) ?? 0) + 1);
    const qCount = new Map<string, number>();
    for (const r of qs ?? []) qCount.set(r.subject, (qCount.get(r.subject) ?? 0) + 1);
    const kindMap = new Map<string, string>();
    const pastCount = new Map<string, number>();
    for (const r of past ?? []) {
      kindMap.set(r.subject, r.kind);
      pastCount.set(r.subject, (pastCount.get(r.subject) ?? 0) + 1);
    }

    // 科目の全集合（過去問とタクソノミーの和集合）
    const subjects = [...new Set([...pastCount.keys(), ...taxCount.keys()])].map((subject) => ({
      subject,
      kind: kindMap.get(subject) ?? null,
      taxonomy_items: taxCount.get(subject) ?? 0,
      pool: qCount.get(subject) ?? 0,
      past_questions: pastCount.get(subject) ?? 0,
    }));
    subjects.sort((a, b) => (a.kind ?? "").localeCompare(b.kind ?? "") || a.subject.localeCompare(b.subject, "ja"));
    return NextResponse.json({ subjects });
  } catch (e) {
    await logError("subjects", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
