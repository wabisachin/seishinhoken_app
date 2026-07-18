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
  const [totalWrong, setTotalWrong] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/subjects")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setSubjects(d.subjects)))
      .catch((e) => setError(String(e)));
    fetch("/api/quiz/review-summary")
      .then((r) => r.json())
      .then((d) => setTotalWrong(typeof d.totalWrong === "number" ? d.totalWrong : null))
      .catch(() => setTotalWrong(null));
  }, []);

  const common = subjects.filter((s) => s.kind === "common");
  const specialized = subjects.filter((s) => s.kind === "specialized");
  const other = subjects.filter((s) => !s.kind);

  return (
    <div className="space-y-6">
      {totalWrong !== null && totalWrong > 0 && (
        <Link
          href="/quiz?mode=review"
          className="block rounded-2xl border-l-4 border-rose-500 bg-rose-50 p-4 shadow-warm transition-all hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <p className="text-sm text-rose-900">
            <span className="text-lg font-bold">{totalWrong}問</span>
            が間違えたまま復習待ちです。この学習の最終ゴールは、間違えた問題を全て復習モードで解き直し、
            <span className="font-medium">この数を0にすること</span>
            です。
          </p>
        </Link>
      )}
      {totalWrong === 0 && (
        <div className="rounded-2xl border-l-4 border-green-500 bg-green-50 p-4 shadow-warm">
          <p className="text-sm text-green-900">現在、間違えたまま残っている問題はありません。演習を続けて苦手を早めに見つけましょう。</p>
        </div>
      )}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link
          href="/quiz?mode=subject"
          className="rounded-2xl border-l-4 border-indigo-400 bg-white p-5 shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <h2 className="font-bold text-indigo-700">分野別演習</h2>
          <p className="mt-1 text-sm text-stone-600">科目を選んで集中的に演習</p>
        </Link>
        <Link
          href="/quiz?mode=mock"
          className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <h2 className="font-bold text-violet-700">全分野ミニ模試</h2>
          <p className="mt-1 text-sm text-stone-600">本番の科目配分で横断出題</p>
        </Link>
        <Link
          href="/quiz?mode=review"
          className="rounded-2xl border-l-4 border-rose-400 bg-white p-5 shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <h2 className="font-bold text-rose-700">復習モード</h2>
          <p className="mt-1 text-sm text-stone-600">間違えた問題をやり直す</p>
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

            {/* モバイル: カード表示 */}
            <div className="space-y-2 sm:hidden">
              {(rows as SubjectRow[]).map((s) => (
                <div key={s.subject} className="rounded-2xl bg-white p-4 shadow-warm-sm">
                  <p className="font-medium">{s.subject}</p>
                  <div className="mt-2 flex gap-4 text-sm text-stone-500">
                    <span>問題プール {s.pool}</span>
                    <span>出題基準項目 {s.taxonomy_items}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* sm以上: テーブル表示 */}
            <div className="hidden overflow-hidden rounded-2xl bg-white shadow-warm sm:block">
              <table className="w-full text-sm">
                <thead className="bg-stone-100 text-left">
                  <tr>
                    <th className="px-4 py-2">科目</th>
                    <th className="px-3 py-2 text-right">問題プール</th>
                    <th className="px-3 py-2 text-right">出題基準項目</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows as SubjectRow[]).map((s) => (
                    <tr key={s.subject} className="border-t border-stone-100">
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
