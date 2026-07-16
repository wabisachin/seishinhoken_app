"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Summary = {
  totalAttempts: number;
  totalCorrect: number;
  overallAccuracy: number;
  recentAttempts: number;
  subjectsPracticed: number;
  totalSubjects: number;
};
type SubjectStat = { subject: string; kind: string | null; attempts: number; correct: number; accuracy: number };
type KindStat = { kind: string; attempts: number; correct: number; accuracy: number };
type TimelineRow = { day: string; attempts: number; accuracy: number };
type MonthlyRow = { month: string; attempts: number; accuracy: number };

const KIND_LABEL: Record<string, string> = { common: "共通科目", specialized: "専門科目", other: "その他" };
// 1〜2回だけ答えた科目がたまたま得意/苦手TOPに出てしまわないよう、最低解答数を設ける
const MIN_ATTEMPTS_FOR_RANKING = 3;

// 科目名は長いものだと30文字を超え、グラフの縦軸幅にはとても収まらない。
// SVGは自動で折り返したり省略記号を付けたりしないため、放置すると単に途中で
// 切れて見える。ここで明示的に省略し、全文はホバー時のTooltip・下の表/カードで見せる。
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

export default function StatsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [bySubject, setBySubject] = useState<SubjectStat[]>([]);
  const [byKind, setByKind] = useState<KindStat[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setSummary(d.summary);
          setBySubject(d.bySubject);
          setByKind(d.byKind ?? []);
          setTimeline(d.timeline);
          setMonthly(d.monthly);
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>;
  if (bySubject.length === 0)
    return <p className="text-stone-600">まだ解答記録がありません。演習すると科目別の成績が表示されます。</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">成績</h1>

      {summary && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl bg-white p-4 shadow-warm">
            <p className="text-xs text-stone-500">総合正答率</p>
            <p className="text-2xl font-bold text-indigo-700">{summary.overallAccuracy}%</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-warm">
            <p className="text-xs text-stone-500">総解答数</p>
            <p className="text-2xl font-bold text-stone-800">{summary.totalAttempts.toLocaleString()}問</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-warm">
            <p className="text-xs text-stone-500">直近7日間</p>
            <p className="text-2xl font-bold text-stone-800">{summary.recentAttempts.toLocaleString()}問</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-warm">
            <p className="text-xs text-stone-500">取り組んだ科目</p>
            <p className="text-2xl font-bold text-stone-800">
              {summary.subjectsPracticed}
              <span className="text-sm font-normal text-stone-400"> / {summary.totalSubjects}</span>
            </p>
          </div>
        </section>
      )}

      {byKind.length > 0 && (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {byKind.map((k) => (
            <div key={k.kind} className="rounded-2xl bg-white p-4 shadow-warm">
              <p className="text-xs text-stone-500">{KIND_LABEL[k.kind] ?? k.kind}</p>
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
        const ranked = bySubject.filter((s) => s.attempts >= MIN_ATTEMPTS_FOR_RANKING);
        if (ranked.length === 0) return null;
        const weakest = ranked.slice(0, 3);
        const strongest = [...ranked].reverse().slice(0, 3);
        return (
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-white p-4 shadow-warm">
              <h2 className="mb-2 font-bold text-red-700">苦手科目 TOP3</h2>
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
              <h2 className="mb-2 font-bold text-green-700">得意科目 TOP3</h2>
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
        <h2 className="mb-3 font-bold text-indigo-700">科目別正答率（苦手順）</h2>
        <ResponsiveContainer width="100%" height={Math.max(300, bySubject.length * 32)}>
          <BarChart data={bySubject} layout="vertical" margin={{ left: 0, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" domain={[0, 100]} unit="%" />
            <YAxis type="category" dataKey="subject" width={110} tick={<SubjectAxisTick x={0} y={0} payload={{ value: "" }} />} />
            <Tooltip formatter={(v: number) => [`${v}%`, "正答率"]} labelFormatter={(label: string) => label} />
            <Bar dataKey="accuracy" fill="#4f46e5" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>

        {/* モバイル: カード表示 */}
        <div className="mt-4 space-y-2 sm:hidden">
          {bySubject.map((s) => (
            <div key={s.subject} className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2 text-sm">
              <span>{s.subject}</span>
              <span className="flex items-center gap-3 text-stone-500">
                <span>{s.correct}/{s.attempts}問</span>
                <span className={`font-medium ${s.accuracy >= 60 ? "text-green-600" : "text-red-600"}`}>
                  {s.accuracy}%
                </span>
              </span>
            </div>
          ))}
        </div>

        {/* sm以上: テーブル表示 */}
        <table className="mt-4 hidden w-full text-sm sm:table">
          <thead className="bg-stone-100 text-left">
            <tr>
              <th className="px-3 py-1.5">科目</th>
              <th className="px-3 py-1.5 text-right">解答数</th>
              <th className="px-3 py-1.5 text-right">正解数</th>
              <th className="px-3 py-1.5 text-right">正答率</th>
            </tr>
          </thead>
          <tbody>
            {bySubject.map((s) => (
              <tr key={s.subject} className="border-t border-stone-100">
                <td className="px-3 py-1.5">{s.subject}</td>
                <td className="px-3 py-1.5 text-right">{s.attempts}</td>
                <td className="px-3 py-1.5 text-right">{s.correct}</td>
                <td
                  className={`px-3 py-1.5 text-right font-medium ${
                    s.accuracy >= 60 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {s.accuracy}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-400">※ 本番の合格基準は総得点の約60%（+全科目群で得点）</p>
      </section>

      {monthly.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="mb-3 font-bold text-indigo-700">月ごとの正答率推移</h2>
          <ResponsiveContainer width="100%" height={260}>
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
          <p className="mt-2 text-xs text-stone-400">
            {monthly.map((m) => `${formatMonth(m.month)}: ${m.attempts}問`).join(" / ")}
          </p>
        </section>
      )}

      {timeline.length > 1 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="mb-3 font-bold text-indigo-700">日ごとの正答率推移</h2>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={timeline}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} unit="%" />
              <Tooltip />
              <Line type="monotone" dataKey="accuracy" stroke="#4f46e5" strokeWidth={2} name="正答率" />
            </LineChart>
          </ResponsiveContainer>
        </section>
      )}
    </div>
  );
}
