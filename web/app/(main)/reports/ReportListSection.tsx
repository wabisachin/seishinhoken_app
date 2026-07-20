"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ReportSummary = {
  id: number;
  period_month: string;
  generated_at: string;
  read_at: string | null;
  metrics: { answeredThisMonth: number; newWeaknessesDiscovered: number; weaknessesOvercome: number };
};

function formatMonth(dateStr: string) {
  const [y, m] = dateStr.slice(0, 7).split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

/**
 * 成績ページ末尾に置く振り返りレポート一覧。本人・動作テスト用のstats/page.tsxからは
 * 自分自身のprofileを、応援する人のGuardianView.tsxからは常に"self"を渡す
 * （応援する人は本人のデータプールしか持たないため）。
 */
export default function ReportListSection({ profile }: { profile: "self" | "test" }) {
  const [reports, setReports] = useState<ReportSummary[] | null>(null);

  useEffect(() => {
    fetch(`/api/reports?profile=${profile}`)
      .then((r) => r.json())
      .then((d) => setReports(d.reports ?? []))
      .catch(() => setReports([]));
  }, [profile]);

  if (!reports || reports.length === 0) return null;

  return (
    <section className="rounded-2xl bg-white p-5 shadow-warm">
      <h2 className="mb-1 font-bold text-indigo-700">学習の振り返りレポート</h2>
      <p className="mb-3 text-xs text-stone-400">
        月が変わるたびに、その月の振り返りと次の月の学習プランが届きます。
      </p>
      <div className="space-y-1.5">
        {reports.map((r) => (
          <Link
            key={r.id}
            href={`/reports/${r.id}?profile=${profile}`}
            className="flex items-center justify-between gap-2 rounded-xl bg-stone-50 p-3 transition-colors hover:bg-indigo-50"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-stone-800">
                {formatMonth(r.period_month)}の振り返り
                {r.read_at === null && (
                  <span className="shrink-0 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold text-white">NEW</span>
                )}
              </p>
              <p className="mt-0.5 truncate text-xs text-stone-500">
                {r.metrics.answeredThisMonth}問解答・新規弱点{r.metrics.newWeaknessesDiscovered}件・克服{r.metrics.weaknessesOvercome}件
              </p>
            </div>
            <span className="shrink-0 text-xs text-stone-400">詳細 →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
