"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type ReviewSubject = { subject: string; correct: number; total: number; wrongCount: number; accuracy: number | null };
type ExamSummary = {
  thisMonth: string;
  thisMonthAttempts: number;
  thisMonthAccuracy: number;
  subjectsPracticed: number;
};
type MonthlyRow = { month: string; attempts: number; accuracy: number };
type NextAction = { action: "subject" | "mock" | "exam"; targetSubject: string | null; reason: string; href: string };

const ACTION_LABEL: Record<NextAction["action"], string> = { subject: "科目別演習", mock: "全科目演習", exam: "実戦模試" };

function formatMonth(month: string) {
  const [y, m] = month.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

function ProgressRing({ percent, size = 96 }: { percent: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const deg = Math.round(3.6 * clamped);
  return (
    <div
      className="relative shrink-0 rounded-full"
      style={{ width: size, height: size, background: `conic-gradient(#4f46e5 ${deg}deg, #e7e5e4 ${deg}deg)` }}
    >
      <div className="absolute inset-[7px] flex items-center justify-center rounded-full bg-white">
        <span className="text-xl font-bold text-indigo-700">{clamped}%</span>
      </div>
    </div>
  );
}

function WeaknessRow({ s }: { s: ReviewSubject }) {
  const needsReview = s.wrongCount > 0;
  const accuracyDisplay = s.accuracy ?? 0;
  const barColor = s.accuracy === null ? "bg-stone-200" : s.accuracy < 50 ? "bg-red-500" : s.accuracy < 70 ? "bg-amber-500" : "bg-green-500";
  const content = (
    <div className={`flex items-center gap-3 rounded-xl p-2.5 transition-colors ${needsReview ? "bg-white shadow-warm-sm hover:bg-indigo-50" : "opacity-50"}`}>
      <span className="w-28 shrink-0 truncate text-sm text-stone-700 sm:w-40">{s.subject}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${accuracyDisplay}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs text-stone-500">{s.accuracy !== null ? `${s.accuracy}%` : "―"}</span>
      {needsReview ? (
        <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">残り{s.wrongCount}</span>
      ) : (
        <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">OK</span>
      )}
    </div>
  );
  return needsReview ? (
    <Link href={`/quiz?mode=review&subject=${encodeURIComponent(s.subject)}`} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

export default function Dashboard() {
  const [reviewSubjects, setReviewSubjects] = useState<ReviewSubject[] | null>(null);
  const [everMissed, setEverMissed] = useState(0);
  const [totalWrong, setTotalWrong] = useState(0);
  const [examSummary, setExamSummary] = useState<ExamSummary | null>(null);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [examRemainingThisMonth, setExamRemainingThisMonth] = useState<number | null>(null);
  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [nextActionLoading, setNextActionLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/home/next-action")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setNextAction(d as NextAction);
      })
      .catch(() => {})
      .finally(() => setNextActionLoading(false));

    fetch("/api/quiz/review-summary")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setReviewSubjects(d.subjects ?? []);
        setEverMissed(d.everMissed ?? 0);
        setTotalWrong(d.totalWrong ?? 0);
      })
      .catch((e) => setError(String(e)));

    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setExamSummary(d.summary);
        setMonthly(d.monthly ?? []);
      })
      .catch((e) => setError(String(e)));

    fetch("/api/exam/state")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setExamRemainingThisMonth(d.remainingThisMonth ?? null);
      })
      .catch(() => {});
  }, []);

  const consumedPercent = everMissed > 0 ? Math.round((100 * (everMissed - totalWrong)) / everMissed) : null;
  const needsReview = (reviewSubjects ?? []).filter((s) => s.wrongCount > 0);
  const mastered = (reviewSubjects ?? []).filter((s) => s.wrongCount === 0);
  const SHOWN_MASTERED = 4;
  const shownMastered = mastered.slice(0, SHOWN_MASTERED);
  const hiddenMasteredCount = mastered.length - shownMastered.length;

  return (
    <div className="space-y-6">
      {!nextActionLoading && nextAction && (
        <section className="rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 p-5 text-white shadow-warm">
          <p className="text-xs font-medium text-indigo-100">おすすめの次の一手</p>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-lg font-bold">
                {ACTION_LABEL[nextAction.action]}
                {nextAction.targetSubject ? `：${nextAction.targetSubject}` : ""}
              </p>
              <p className="mt-0.5 text-sm text-indigo-50">{nextAction.reason}</p>
            </div>
            <Link
              href={nextAction.href}
              className="min-h-11 shrink-0 rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-indigo-700 transition-colors hover:bg-indigo-50"
            >
              始める
            </Link>
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link
          href="/quiz?mode=subject"
          className="rounded-2xl border-l-4 border-indigo-400 bg-white p-5 shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <h2 className="font-bold text-indigo-700">科目別演習</h2>
          <p className="mt-1 text-sm text-stone-600">科目を選んで集中的に演習</p>
        </Link>
        <Link
          href="/quiz?mode=mock"
          className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <h2 className="font-bold text-violet-700">全科目演習</h2>
          <p className="mt-1 text-sm text-stone-600">全18科目を1問ずつ横断演習</p>
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

      {/* 弱点ゼロまで */}
      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="mb-3 font-bold text-indigo-700">弱点ゼロまで</h2>
        {consumedPercent === null ? (
          <p className="text-sm text-stone-600">
            まだ間違えた問題がありません。科目別演習や全科目演習に取り組むと、ここに弱点克服の進み具合が表示されます。
          </p>
        ) : (
          <div className="flex items-center gap-5">
            <ProgressRing percent={consumedPercent} />
            <div>
              <p className="text-2xl font-bold text-stone-800">
                残り<span className="text-red-600">{totalWrong}</span>問
              </p>
              <p className="mt-1 text-sm text-stone-500">
                これまで間違えた{everMissed}問のうち{everMissed - totalWrong}問を克服済み（{consumedPercent}%消化）
              </p>
            </div>
          </div>
        )}
      </section>

      {/* 科目別弱点マップ */}
      {reviewSubjects && reviewSubjects.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="mb-1 font-bold text-indigo-700">科目別弱点マップ</h2>
          <p className="mb-3 text-xs text-stone-400">悪い順に表示。タップするとその科目の復習を始めます。</p>
          <div className="space-y-1.5">
            {needsReview.map((s) => (
              <WeaknessRow key={s.subject} s={s} />
            ))}
            {shownMastered.map((s) => (
              <WeaknessRow key={s.subject} s={s} />
            ))}
          </div>
          {hiddenMasteredCount > 0 && (
            <p className="mt-2 text-xs text-stone-400">ほか{hiddenMasteredCount}科目は順調です</p>
          )}
          {needsReview.length === 0 && mastered.length === 0 && (
            <p className="text-sm text-stone-500">まだ演習データがありません。</p>
          )}
        </section>
      )}

      {/* 実戦模試の実力推移 */}
      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-bold text-indigo-700">実戦模試の実力推移</h2>
          {examRemainingThisMonth !== null && (
            <span className="text-xs text-stone-500">今月あと{examRemainingThisMonth}回受験可</span>
          )}
        </div>
        {!examSummary || examSummary.subjectsPracticed === 0 ? (
          <div className="space-y-2 text-sm text-stone-600">
            <p>
              ここには実戦模試（本番と同じ形式・時間制限・一度も出題されていない問題だけで構成される模試）の
              結果だけが表示されます。「未知の問題への対応力」を測るには、まず実戦模試を受けてみましょう。
            </p>
            <Link
              href="/full-mock"
              className="inline-flex min-h-12 items-center rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
            >
              実戦模試を受けてみる
            </Link>
          </div>
        ) : monthly.length === 0 ? (
          <p className="text-sm text-stone-500">今月はまだ実戦模試を受けていません。</p>
        ) : (
          <>
            <div className="mb-3 flex items-baseline gap-3">
              <p className={`text-3xl font-bold ${examSummary.thisMonthAccuracy >= 60 ? "text-green-600" : "text-red-600"}`}>
                {examSummary.thisMonthAccuracy}%
              </p>
              <p className="text-xs text-stone-500">
                {formatMonth(examSummary.thisMonth)}・{examSummary.thisMonthAttempts}問解答（合格ライン60%）
              </p>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tickFormatter={formatMonth} tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 100]} unit="%" />
                <Tooltip
                  labelFormatter={(label: string) => formatMonth(label)}
                  formatter={(v: number, name: string) => (name === "accuracy" ? [`${v}%`, "得点率"] : [v, name])}
                />
                <ReferenceLine y={60} stroke="#dc2626" strokeDasharray="4 4" label={{ value: "合格ライン", position: "insideTopLeft", fontSize: 10, fill: "#dc2626" }} />
                <Bar dataKey="accuracy" name="得点率" fill="#7c3aed" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </section>
    </div>
  );
}
