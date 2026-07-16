"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type SubjectRow = {
  subject: string;
  kind: string | null;
  taxonomy_items: number;
  pool: number;
  past_questions: number;
};

export default function Dashboard() {
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/subjects")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setSubjects(d.subjects)))
      .catch((e) => setError(String(e)));
  }, []);

  const common = subjects.filter((s) => s.kind === "common");
  const specialized = subjects.filter((s) => s.kind === "specialized");
  const other = subjects.filter((s) => !s.kind);

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link href="/quiz?mode=subject" className="rounded-xl bg-white p-5 shadow hover:shadow-md">
          <h2 className="font-bold text-indigo-700">分野別演習</h2>
          <p className="mt-1 text-sm text-slate-600">科目を選んで集中的に演習（問題は解いている間にバックグラウンドで生成されます）</p>
        </Link>
        <Link href="/quiz?mode=mock" className="rounded-xl bg-white p-5 shadow hover:shadow-md">
          <h2 className="font-bold text-indigo-700">全分野ミニ模試</h2>
          <p className="mt-1 text-sm text-slate-600">本番の科目配分で横断出題</p>
        </Link>
        <Link href="/quiz?mode=review" className="rounded-xl bg-white p-5 shadow hover:shadow-md">
          <h2 className="font-bold text-indigo-700">復習モード</h2>
          <p className="mt-1 text-sm text-slate-600">間違えた問題をやり直す</p>
        </Link>
      </section>

      {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}

      {[
        ["共通科目", common],
        ["専門科目", specialized],
        ["その他", other],
      ].map(([title, rows]) =>
        (rows as SubjectRow[]).length === 0 ? null : (
          <section key={title as string}>
            <h2 className="mb-2 font-bold">{title as string}</h2>
            <div className="overflow-hidden rounded-xl bg-white shadow">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-left">
                  <tr>
                    <th className="px-4 py-2">科目</th>
                    <th className="px-3 py-2 text-right">問題プール</th>
                    <th className="px-3 py-2 text-right">出題基準項目</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows as SubjectRow[]).map((s) => (
                    <tr key={s.subject} className="border-t border-slate-100">
                      <td className="px-4 py-2">{s.subject}</td>
                      <td className="px-3 py-2 text-right">{s.pool}</td>
                      <td className="px-3 py-2 text-right">{s.taxonomy_items}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ),
      )}
    </div>
  );
}
