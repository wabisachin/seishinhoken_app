import { supabase } from "./supabase";

/** 科目の全集合（過去問とタクソノミーの和集合）。/api/subjects と同じ定義。 */
export async function listSubjects(): Promise<string[]> {
  const sb = supabase();
  const [{ data: tax }, { data: past }] = await Promise.all([
    sb.from("taxonomy").select("subject"),
    sb.from("past_questions").select("subject"),
  ]);
  const set = new Set<string>();
  for (const r of tax ?? []) set.add(r.subject);
  for (const r of past ?? []) set.add(r.subject);
  return [...set];
}
