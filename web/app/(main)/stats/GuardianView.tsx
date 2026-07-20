"use client";

import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { describeFailedGroups } from "@/lib/examFormat";
import ReportListSection from "../reports/ReportListSection";

type SubjectScore = { subject: string; correct: number; total: number };
type Verdict = {
  passed: boolean;
  overallRate: number;
  totalCorrect: number;
  totalQuestions: number;
  failedGroups: string[];
};
type HistoryRow = { examAttemptId: number; completedAt: string; verdict: Verdict; bySubject: SubjectScore[] };
type ReviewSubject = { subject: string; total: number; wrongCount: number; everMissed: number; poolFull: boolean };

function formatMonth(month: string) {
  const [y, m] = month.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

/**
 * 「応援する人」向けの成績画面。本人向け(page.tsx本体)は本人が自分の学習を進めるための
 * 画面だが、応援する人は問題を解かない第三者（保護者など）なので、見たいものが違う:
 * (1) 実戦模試（未知の問題での本番形式）の月別推移・今月の詳細な結果、
 * (2) 本人がどれだけ演習に取り組み、どれだけ弱点が残っているかの進捗。
 * どちらも「ぱっと見でわかる」ことを優先し、本人向け画面にあるような次の一手の
 * 提案やクリックして演習を始めるリンクは持たない（応援する人は演習ページに入れない）。
 */
export default function GuardianView() {
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [reviewSubjects, setReviewSubjects] = useState<ReviewSubject[] | null>(null);
  const [totalWrong, setTotalWrong] = useState(0);
  const [everMissed, setEverMissed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 応援する人は自分のデータプールを持たず、常に本人(self)のデータだけを見る
    // （profile切り替えの概念自体を持たない）。
    fetch("/api/exam/history?profile=self")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setHistory(d.history ?? []);
      })
      .catch(() => setError("データの読み込みに失敗しました。時間をおいて再度お試しください。"));

    fetch("/api/quiz/review-summary?profile=self")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setReviewSubjects(d.subjects ?? []);
        setTotalWrong(d.totalWrong ?? 0);
        setEverMissed(d.everMissed ?? 0);
      })
      .catch(() => setError("データの読み込みに失敗しました。時間をおいて再度お試しください。"));
  }, []);

  if (error) return <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>;
  if (!history || !reviewSubjects) return null;

  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisMonthRounds = history.filter((h) => h.completedAt.slice(0, 7) === thisMonth);
  const passCount = thisMonthRounds.filter((h) => h.verdict.passed).length;
  const totalCorrectSum = thisMonthRounds.reduce((sum, h) => sum + h.verdict.totalCorrect, 0);
  const totalQuestionsSum = thisMonthRounds.reduce((sum, h) => sum + h.verdict.totalQuestions, 0);
  const overallRateThisMonth = totalQuestionsSum > 0 ? Math.round((100 * totalCorrectSum) / totalQuestionsSum) : null;

  // 科目ごとの得点率（今月受けた回の合算）
  const subjectAgg = new Map<string, { correct: number; total: number }>();
  for (const h of thisMonthRounds) {
    for (const s of h.bySubject) {
      const cur = subjectAgg.get(s.subject) ?? { correct: 0, total: 0 };
      cur.correct += s.correct;
      cur.total += s.total;
      subjectAgg.set(s.subject, cur);
    }
  }
  const subjectRatesThisMonth = [...subjectAgg.entries()]
    .map(([subject, v]) => ({ subject, rate: v.total > 0 ? Math.round((100 * v.correct) / v.total) : 0, total: v.total }))
    .sort((a, b) => a.rate - b.rate);

  // 今月受けたいずれかの回で0点だった科目群（本番の合否基準そのもの。1つでもあれば即不合格）
  const zeroGroupsThisMonth = [...new Set(thisMonthRounds.flatMap((h) => h.verdict.failedGroups))];

  // 月ごとの平均得点率推移（全期間）
  const monthlyMap = new Map<string, { correct: number; total: number }>();
  for (const h of history) {
    const m = h.completedAt.slice(0, 7);
    const cur = monthlyMap.get(m) ?? { correct: 0, total: 0 };
    cur.correct += h.verdict.totalCorrect;
    cur.total += h.verdict.totalQuestions;
    monthlyMap.set(m, cur);
  }
  const monthlyTrend = [...monthlyMap.entries()]
    .map(([month, v]) => ({ month, rate: v.total > 0 ? Math.round((100 * v.correct) / v.total) : 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const totalAnswered = reviewSubjects.reduce((sum, s) => sum + s.total, 0);
  const totalCleared = Math.max(0, everMissed - totalWrong);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">成績</h1>

      {monthlyTrend.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="mb-3 font-bold text-indigo-700">実戦模試 月別の平均得点率</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyTrend}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tickFormatter={formatMonth} tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} unit="%" />
              <Tooltip
                labelFormatter={(label: string) => formatMonth(label)}
                formatter={(v: number) => [`${v}%`, "得点率"]}
              />
              <Bar dataKey="rate" name="得点率" fill="#7c3aed" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="mb-3 font-bold text-indigo-700">{formatMonth(thisMonth)}の実戦模試</h2>
        {thisMonthRounds.length === 0 ? (
          <p className="text-sm text-stone-500">今月はまだ実戦模試を受けていません。</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-stone-800">{thisMonthRounds.length}回</p>
                <p className="text-xs text-stone-500">受験回数</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">{passCount}回</p>
                <p className="text-xs text-stone-500">合格</p>
              </div>
              <div>
                <p className={`text-2xl font-bold ${overallRateThisMonth !== null && overallRateThisMonth >= 60 ? "text-green-600" : "text-red-600"}`}>
                  {overallRateThisMonth}%
                </p>
                <p className="text-xs text-stone-500">合計得点率</p>
              </div>
            </div>

            {zeroGroupsThisMonth.length > 0 && (
              <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">
                今月、1問も正解できなかった科目群がありました: {describeFailedGroups(zeroGroupsThisMonth)}
                （本番ではここが1つでもあると総得点に関係なく不合格になります）
              </p>
            )}

            <div className="mt-4">
              <h3 className="mb-2 text-sm font-bold text-stone-600">科目ごとの得点率（今月）</h3>
              <div className="space-y-1.5">
                {subjectRatesThisMonth.map((s) => (
                  <div key={s.subject} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-xs text-stone-600 sm:w-36">{s.subject}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                      <div
                        className={`h-full rounded-full ${s.rate >= 60 ? "bg-green-500" : "bg-red-400"}`}
                        style={{ width: `${s.rate}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right text-xs text-stone-500">{s.rate}%</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="mb-1 font-bold text-indigo-700">学習の進捗（演習）</h2>
        <p className="mb-3 text-xs text-stone-400">科目別演習・全科目演習での取り組み状況です。</p>
        <div className="mb-4 grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-2xl font-bold text-stone-800">{totalAnswered}問</p>
            <p className="text-xs text-stone-500">総問題数</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-red-600">{totalWrong}問</p>
            <p className="text-xs text-stone-500">未克服</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-green-600">{totalCleared}問</p>
            <p className="text-xs text-stone-500">克服済み</p>
          </div>
        </div>
        <div className="space-y-1.5">
          {reviewSubjects.map((s) => {
            const cleared = Math.max(0, s.everMissed - s.wrongCount);
            return (
              <div key={s.subject} className="flex items-center gap-2 rounded-xl bg-stone-50 p-2">
                <span className="w-28 shrink-0 truncate text-xs text-stone-700 sm:w-36">{s.subject}</span>
                <span className="flex-1 text-right text-[11px] text-stone-500">{s.total}問</span>
                {s.wrongCount > 0 ? (
                  <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                    未克服{s.wrongCount}問
                  </span>
                ) : s.total === 0 ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">未挑戦</span>
                ) : (
                  <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">
                    克服{cleared}問
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <ReportListSection profile="self" />
    </div>
  );
}
