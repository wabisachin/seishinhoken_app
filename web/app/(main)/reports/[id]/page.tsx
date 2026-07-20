"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getStoredProfile } from "@/lib/profile";

type MonthMetrics = {
  periodMonth: string;
  answeredThisMonth: number;
  newWeaknessesDiscovered: number;
  weaknessesOvercome: number;
  bySubjectWrong: { subject: string; wrongCount: number }[];
  byMinorWrong: { subject: string; minor: string; wrongCount: number }[];
};
type FormatWeakness = {
  caseWrong: number;
  caseTotal: number;
  nocaseWrong: number;
  nocaseTotal: number;
  multiWrong: number;
  multiTotal: number;
  singleWrong: number;
  singleTotal: number;
};
type MistakeAnalysis = {
  patterns: { category: string; count: number; exampleQuestionIds: number[] }[];
  fundamentalIssues: { label: string; evidence: string; supportingQuestionIds: number[] }[];
  formatWeakness: FormatWeakness;
};
type SubjectPlanEntry = { subject: string; reviewTarget: number; practiceTarget: number; priorityRank: 1 | 2 | 3 };
type MonthlyPlan = { bySubject: SubjectPlanEntry[]; totalTarget: number; examDaysRemaining: number };
type Narrative = {
  greeting: string;
  highlights: string[];
  weaknessNarrative: string;
  focusAreas: string[];
  focusAreasSummary: string;
  planNarration: string;
};
type Report = {
  id: number;
  period_month: string;
  generated_at: string;
  metrics: MonthMetrics;
  mistake_analysis: MistakeAnalysis;
  plan: MonthlyPlan;
  narrative: Narrative;
};

function formatMonth(dateStr: string) {
  const [y, m] = dateStr.slice(0, 7).split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

function rateOf(wrong: number, total: number): number {
  return total > 0 ? Math.round((100 * wrong) / total) : 0;
}

function ReportDetailInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const profile = searchParams.get("profile");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    fetch(`/api/reports/${params.id}?profile=${profile}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setReport(d.report);
      })
      .catch(() => setError("レポートの読み込みに失敗しました。"));
  }, [params.id, profile]);

  // 既読化は「レポートの所有者(self/test)本人がこの画面を開いた」場合のみ行う。
  // 応援する人がprofile=selfを指定して本人のレポートを開いても、本人の既読状態は変えない。
  useEffect(() => {
    if (!profile || !report) return;
    if (getStoredProfile() !== profile) return;
    fetch(`/api/reports/${report.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    }).catch(() => {});
  }, [profile, report]);

  if (error) return <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>;
  if (!report) return <p className="text-sm text-stone-500">読み込み中...</p>;

  const { metrics, mistake_analysis, plan, narrative } = report;
  const patternChartData = mistake_analysis.patterns
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((p) => ({ category: p.category, count: p.count }));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/stats" className="text-xs text-stone-400 underline underline-offset-2">
          ← 成績ページに戻る
        </Link>
        <h1 className="mt-1 text-xl font-bold">{formatMonth(report.period_month)}の振り返りレポート</h1>
      </div>

      <section className="rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 p-5 text-white shadow-warm">
        <p className="text-sm leading-relaxed">{narrative.greeting}</p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="mb-3 font-bold text-indigo-700">今月の数字</h2>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-2xl font-bold text-stone-800">{metrics.answeredThisMonth}問</p>
            <p className="text-xs text-stone-500">解答数</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-amber-600">{metrics.newWeaknessesDiscovered}件</p>
            <p className="text-xs text-stone-500">新規に発見した弱点</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-green-600">{metrics.weaknessesOvercome}件</p>
            <p className="text-xs text-stone-500">克服した弱点</p>
          </div>
        </div>
      </section>

      {narrative.highlights.length > 0 && (
        <section className="rounded-2xl border-l-4 border-amber-400 bg-amber-50 p-5 shadow-warm">
          <h2 className="mb-2 font-bold text-amber-800">良かった点</h2>
          <ul className="space-y-1.5 text-sm leading-relaxed text-amber-900">
            {narrative.highlights.map((h, i) => (
              <li key={i} className="flex gap-2">
                <span>✨</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="mb-2 font-bold text-indigo-700">弱点の傾向</h2>
        <p className="text-sm leading-relaxed text-stone-700">{narrative.weaknessNarrative}</p>

        {patternChartData.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-bold text-stone-500">誤答の型の分布（直近の誤答問題の分析）</p>
            <ResponsiveContainer width="100%" height={Math.max(120, patternChartData.length * 36)}>
              <BarChart data={patternChartData} layout="vertical" margin={{ left: 0, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" allowDecimals={false} />
                <YAxis type="category" dataKey="category" width={110} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => [`${v}件`, "件数"]} />
                <Bar dataKey="count" fill="#dc2626" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {(mistake_analysis.formatWeakness.caseTotal > 0 || mistake_analysis.formatWeakness.nocaseTotal > 0) && (
          <div className="mt-4 grid grid-cols-2 gap-3 text-center text-xs">
            <div className="rounded-lg bg-stone-50 p-2">
              <p className="text-stone-500">事例問題の誤答率</p>
              <p className="text-lg font-bold text-stone-800">
                {rateOf(mistake_analysis.formatWeakness.caseWrong, mistake_analysis.formatWeakness.caseTotal)}%
              </p>
            </div>
            <div className="rounded-lg bg-stone-50 p-2">
              <p className="text-stone-500">知識問題の誤答率</p>
              <p className="text-lg font-bold text-stone-800">
                {rateOf(mistake_analysis.formatWeakness.nocaseWrong, mistake_analysis.formatWeakness.nocaseTotal)}%
              </p>
            </div>
          </div>
        )}

        {mistake_analysis.fundamentalIssues.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-bold text-stone-500">本質的な課題 TOP{mistake_analysis.fundamentalIssues.length}</p>
            {mistake_analysis.fundamentalIssues.map((issue, i) => (
              <div key={i} className="flex gap-2 rounded-xl bg-red-50 p-3 text-sm">
                <span className="shrink-0 font-bold text-red-400">{i + 1}位</span>
                <div>
                  <p className="font-bold text-red-800">{issue.label}</p>
                  <p className="mt-1 text-red-700">{issue.evidence}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {metrics.byMinorWrong.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-bold text-stone-500">誤答が多い小単元（今月）</p>
            <ul className="space-y-1 text-sm text-stone-700">
              {metrics.byMinorWrong.slice(0, 8).map((m, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate">
                    {m.subject} / {m.minor}
                  </span>
                  <span className="shrink-0 font-medium text-red-600">{m.wrongCount}問</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {narrative.focusAreas.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="mb-2 font-bold text-indigo-700">次月の重点科目</h2>
          {narrative.focusAreasSummary && (
            <p className="mb-3 text-sm leading-relaxed text-stone-600">{narrative.focusAreasSummary}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {narrative.focusAreas.map((subject, i) => (
              <span key={i} className="rounded-full bg-indigo-50 px-3 py-1.5 text-sm font-bold text-indigo-800">
                {subject}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="mb-2 font-bold text-indigo-700">次月の学習プラン</h2>
        <p className="mb-3 text-sm leading-relaxed text-stone-700">{narrative.planNarration}</p>
        {plan.bySubject.filter((s) => s.reviewTarget + s.practiceTarget > 0).length > 0 && (
          <div className="space-y-1.5">
            {plan.bySubject
              .filter((s) => s.reviewTarget + s.practiceTarget > 0)
              .map((s) => (
                <div key={s.subject} className="flex items-center justify-between gap-2 rounded-lg bg-stone-50 p-2 text-sm">
                  <span className="truncate text-stone-700">{s.subject}</span>
                  <span className="shrink-0 text-stone-500">
                    {s.reviewTarget > 0 && `復習${s.reviewTarget}問`}
                    {s.reviewTarget > 0 && s.practiceTarget > 0 && " / "}
                    {s.practiceTarget > 0 && `演習${s.practiceTarget}問`}
                  </span>
                </div>
              ))}
          </div>
        )}
        <p className="mt-3 text-xs text-stone-400">本番まであと{plan.examDaysRemaining}日</p>
      </section>
    </div>
  );
}

export default function ReportDetailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">読み込み中...</p>}>
      <ReportDetailInner />
    </Suspense>
  );
}
