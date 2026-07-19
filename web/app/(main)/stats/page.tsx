"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getStoredProfile, type UserProfile } from "@/lib/profile";
import GuardianView from "./GuardianView";

type Summary = {
  thisMonth: string;
  thisMonthAttempts: number;
  thisMonthAccuracy: number;
  lastMonth: string;
  lastMonthAttempts: number;
  lastMonthAccuracy: number;
  deltaVsLastMonth: number | null;
  subjectsPracticed: number;
  totalSubjects: number;
};
type SubjectStat = { subject: string; kind: string | null; attempts: number; correct: number; accuracy: number };
type KindStat = { kind: string; attempts: number; correct: number; accuracy: number };
type MonthlyRow = { month: string; attempts: number; accuracy: number };
type SubjectMonthlyRow = { subject: string; month: string; attempts: number; correct: number; accuracy: number };
type Verdict = { passed: boolean; overallRate: number; totalCorrect: number; totalQuestions: number; failedGroups: string[] };
type HistoryRow = { examAttemptId: number; completedAt: string; verdict: Verdict };

const KIND_LABEL: Record<string, string> = { common: "共通科目", specialized: "専門科目", other: "その他" };
// 1回だけ答えた科目がたまたま得意/苦手TOPに出てしまわないよう、最低解答数を設ける
// （当月だけのデータは母数が小さいため、全期間集計より閾値を下げている）
const MIN_ATTEMPTS_FOR_RANKING = 2;
// 科目別の月次推移テーブルに表示する直近の月数
const MONTHLY_TABLE_MONTHS = 4;

const AXIS_MAX_CHARS = 10;
function SubjectAxisTick({ x, y, payload }: { x: number; y: number; payload: { value: string } }) {
  const label = payload.value;
  const display = label.length > AXIS_MAX_CHARS ? `${label.slice(0, AXIS_MAX_CHARS - 1)}…` : label;
  return (
    <text x={x} y={y} dy={3} textAnchor="end" fontSize={10} fill="#57534e">
      {display}
    </text>
  );
}

function formatMonth(month: string) {
  const [y, m] = month.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}
function formatMonthShort(month: string) {
  const [, m] = month.split("-");
  return `${parseInt(m, 10)}月`;
}

export default function StatsPage() {
  const [profile, setProfile] = useState<UserProfile | null | "checking">("checking");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [bySubjectThisMonth, setBySubjectThisMonth] = useState<SubjectStat[]>([]);
  const [byKindThisMonth, setByKindThisMonth] = useState<KindStat[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [bySubjectMonthly, setBySubjectMonthly] = useState<SubjectMonthlyRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProfile(getStoredProfile());
  }, []);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setSummary(d.summary);
          setBySubjectThisMonth(d.bySubjectThisMonth);
          setByKindThisMonth(d.byKindThisMonth ?? []);
          setMonthly(d.monthly);
          setBySubjectMonthly(d.bySubjectMonthly ?? []);
        }
      })
      .catch(() => setError("データの読み込みに失敗しました。時間をおいて再度お試しください。"));

    // 月合算の正答率だけだと、例えば1回目80%・2回目50%で平均65%のように、
    // 実際にはどちらかの回が不合格でも見た目上は合格ラインを超えて見えてしまう。
    // 合否はあくまで「回ごと」に判定されるものなので、回ごとの結果も別途表示する
    fetch("/api/exam/history")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setHistory(d.history ?? []);
      })
      .catch(() => {});
  }, []);

  if (profile === "checking") return null;
  if (profile === "guardian") return <GuardianView />;

  if (error) return <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>;
  if (!summary) return null;
  if (summary.subjectsPracticed === 0)
    return (
      <div className="space-y-3">
        <p className="text-stone-600">
          ここには実戦模試（本番と同じ形式・時間制限・一度も出題されていない問題だけで構成される模試）の
          結果だけが表示されます。まだ実戦模試を受けていないので、成績はまだありません。
        </p>
        <Link
          href="/full-mock"
          className="inline-flex min-h-12 items-center rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
        >
          実戦模試を受けてみる
        </Link>
      </div>
    );

  // 科目別の月次推移テーブル: 直近数ヶ月 × 当月の苦手順で並べた科目
  const recentMonths = [...new Set(bySubjectMonthly.map((r) => r.month))].sort().slice(-MONTHLY_TABLE_MONTHS);
  const subjectOrderForTable =
    bySubjectThisMonth.length > 0
      ? bySubjectThisMonth.map((s) => s.subject)
      : [...new Set(bySubjectMonthly.map((r) => r.subject))];
  const monthlyBySubjectKey = new Map(bySubjectMonthly.map((r) => [`${r.subject}|${r.month}`, r]));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">成績</h1>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <p className="text-sm text-stone-500">{formatMonth(summary.thisMonth)}の成績</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <p className="text-4xl font-bold text-indigo-700">{summary.thisMonthAccuracy}%</p>
          {summary.deltaVsLastMonth !== null && (
            <span
              className={`rounded-full px-2.5 py-1 text-sm font-medium ${
                summary.deltaVsLastMonth >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
              }`}
            >
              前月比 {summary.deltaVsLastMonth >= 0 ? "+" : ""}
              {summary.deltaVsLastMonth}pt
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-stone-500">
          {formatMonth(summary.thisMonth)} {summary.thisMonthAttempts}問解答
          {summary.lastMonthAttempts > 0 && (
            <> ／ {formatMonth(summary.lastMonth)} {summary.lastMonthAttempts}問・{summary.lastMonthAccuracy}%</>
          )}
        </p>
        <p className="mt-2 text-xs text-stone-400">
          ※ 上の数字は今月受けた回をすべて合算したものです。合否は回ごとに判定されるため、
          合算では合格ラインに見えても個別の回では不合格ということがあります。下の「回ごとの結果」で確認してください。
        </p>
      </section>

      {(() => {
        if (!history) return null;
        const thisMonth = new Date().toISOString().slice(0, 7);
        const thisMonthRounds = history.filter((h) => h.completedAt.slice(0, 7) === thisMonth);
        if (thisMonthRounds.length === 0) return null;
        const passCount = thisMonthRounds.filter((h) => h.verdict.passed).length;
        const totalCorrectSum = thisMonthRounds.reduce((sum, h) => sum + h.verdict.totalCorrect, 0);
        const totalQuestionsSum = thisMonthRounds.reduce((sum, h) => sum + h.verdict.totalQuestions, 0);
        const overallRate = totalQuestionsSum > 0 ? Math.round((100 * totalCorrectSum) / totalQuestionsSum) : null;
        const sortedAsc = [...thisMonthRounds].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
        const allSortedAsc = [...history].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
        const roundNumberById = new Map(allSortedAsc.map((h, i) => [h.examAttemptId, i + 1]));
        return (
          <section className="rounded-2xl bg-white p-5 shadow-warm">
            <h2 className="mb-3 font-bold text-indigo-700">{formatMonth(thisMonth)}の回ごとの結果</h2>
            <div className="mb-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-stone-800">{thisMonthRounds.length}回</p>
                <p className="text-xs text-stone-500">受験回数</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">{passCount}回</p>
                <p className="text-xs text-stone-500">合格</p>
              </div>
              <div>
                <p className={`text-2xl font-bold ${overallRate !== null && overallRate >= 60 ? "text-green-600" : "text-red-600"}`}>
                  {overallRate}%
                </p>
                <p className="text-xs text-stone-500">合算得点率</p>
              </div>
            </div>
            <div className="space-y-1.5">
              {sortedAsc.map((h) => (
                <div key={h.examAttemptId} className="flex items-center justify-between gap-2 rounded-xl bg-stone-50 p-2.5">
                  <span className="text-sm font-medium text-stone-700">第{roundNumberById.get(h.examAttemptId)}回</span>
                  <span className="text-xs text-stone-400">{new Date(h.completedAt).toLocaleDateString("ja-JP")}</span>
                  <span className="text-sm text-stone-600">
                    {h.verdict.totalCorrect}/{h.verdict.totalQuestions}（{Math.round(h.verdict.overallRate * 100)}%）
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${h.verdict.passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {h.verdict.passed ? "合格" : "不合格"}
                  </span>
                </div>
              ))}
            </div>
            <Link href="/full-mock" className="mt-3 inline-block text-sm font-medium text-indigo-600 underline underline-offset-2">
              実戦模試で各回の詳細（問題・解答・解説）を見る
            </Link>
          </section>
        );
      })()}

      {summary.thisMonthAttempts === 0 ? (
        <div className="space-y-2 rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
          <p>今月はまだ実戦模試を受けていません。受けると今月の成績が表示されます。</p>
          <Link href="/full-mock" className="font-medium underline underline-offset-2">
            実戦模試を受けてみる
          </Link>
        </div>
      ) : (
        <>
          {byKindThisMonth.length > 0 && (
            <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {byKindThisMonth.map((k) => (
                <div key={k.kind} className="rounded-2xl bg-white p-4 shadow-warm">
                  <p className="text-xs text-stone-500">{KIND_LABEL[k.kind] ?? k.kind}（今月）</p>
                  <div className="mt-1 flex items-baseline gap-2">
                    <p className={`text-2xl font-bold ${k.accuracy >= 60 ? "text-green-600" : "text-red-600"}`}>
                      {k.accuracy}%
                    </p>
                    <p className="text-xs text-stone-400">{k.correct}/{k.attempts}問</p>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className={`h-full rounded-full ${k.accuracy >= 60 ? "bg-green-500" : "bg-red-400"}`}
                      style={{ width: `${Math.min(100, k.accuracy)}%` }}
                    />
                  </div>
                </div>
              ))}
            </section>
          )}

          {(() => {
            const ranked = bySubjectThisMonth.filter((s) => s.attempts >= MIN_ATTEMPTS_FOR_RANKING);
            if (ranked.length === 0) return null;
            const weakest = ranked.slice(0, 3);
            const strongest = [...ranked].reverse().slice(0, 3);
            return (
              <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-2xl bg-white p-4 shadow-warm">
                  <h2 className="mb-2 font-bold text-red-700">苦手科目 TOP3（今月）</h2>
                  <ul className="space-y-1.5 text-sm">
                    {weakest.map((s, i) => (
                      <li key={s.subject} className="flex items-center justify-between gap-2">
                        <span className="truncate text-stone-700">{i + 1}. {s.subject}</span>
                        <span className="shrink-0 font-medium text-red-600">{s.accuracy}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-2xl bg-white p-4 shadow-warm">
                  <h2 className="mb-2 font-bold text-green-700">得意科目 TOP3（今月）</h2>
                  <ul className="space-y-1.5 text-sm">
                    {strongest.map((s, i) => (
                      <li key={s.subject} className="flex items-center justify-between gap-2">
                        <span className="truncate text-stone-700">{i + 1}. {s.subject}</span>
                        <span className="shrink-0 font-medium text-green-600">{s.accuracy}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            );
          })()}

          <section className="rounded-2xl bg-white p-4 shadow-warm sm:p-5">
            <h2 className="mb-3 font-bold text-indigo-700">科目別正答率（今月・苦手順）</h2>
            <ResponsiveContainer width="100%" height={Math.max(200, bySubjectThisMonth.length * 32)}>
              <BarChart data={bySubjectThisMonth} layout="vertical" margin={{ left: 0, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" domain={[0, 100]} unit="%" />
                <YAxis type="category" dataKey="subject" width={110} tick={<SubjectAxisTick x={0} y={0} payload={{ value: "" }} />} />
                <Tooltip formatter={(v: number) => [`${v}%`, "正答率"]} labelFormatter={(label: string) => label} />
                <Bar dataKey="accuracy" fill="#4f46e5" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <p className="mt-2 text-xs text-stone-400">※ 本番の合格基準は総得点の約60%（+全科目群で得点）</p>
          </section>
        </>
      )}

      {monthly.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="mb-3 font-bold text-indigo-700">月ごとの正答率推移</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthly}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tickFormatter={formatMonth} tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} unit="%" />
              <Tooltip
                labelFormatter={(label: string) => formatMonth(label)}
                formatter={(v: number, name: string) => (name === "accuracy" ? [`${v}%`, "正答率"] : [v, name])}
              />
              <Bar dataKey="accuracy" name="正答率" fill="#7c3aed" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      {recentMonths.length > 1 && (
        <section className="overflow-x-auto rounded-2xl bg-white p-4 shadow-warm sm:p-5">
          <h2 className="mb-3 font-bold text-indigo-700">科目別の月次推移</h2>
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-stone-100 text-left">
              <tr>
                <th className="px-3 py-1.5">科目</th>
                {recentMonths.map((m) => (
                  <th key={m} className="px-3 py-1.5 text-right">{formatMonthShort(m)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subjectOrderForTable.map((subject) => (
                <tr key={subject} className="border-t border-stone-100">
                  <td className="max-w-[10rem] truncate px-3 py-1.5">{subject}</td>
                  {recentMonths.map((m) => {
                    const cell = monthlyBySubjectKey.get(`${subject}|${m}`);
                    return (
                      <td
                        key={m}
                        className={`px-3 py-1.5 text-right ${
                          cell ? (cell.accuracy >= 60 ? "text-green-600" : "text-red-600") : "text-stone-300"
                        }`}
                      >
                        {cell ? `${cell.accuracy}%` : "―"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="text-xs text-stone-400">
        取り組んだ科目（全期間）: {summary.subjectsPracticed} / {summary.totalSubjects}
      </p>
    </div>
  );
}
