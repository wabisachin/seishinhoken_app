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

type SubjectStat = { subject: string; attempts: number; correct: number; accuracy: number };
type TimelineRow = { day: string; attempts: number; accuracy: number };

export default function StatsPage() {
  const [bySubject, setBySubject] = useState<SubjectStat[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setBySubject(d.bySubject);
          setTimeline(d.timeline);
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>;
  if (bySubject.length === 0)
    return <p className="text-slate-600">まだ解答記録がありません。演習すると科目別の成績が表示されます。</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">成績</h1>

      <section className="rounded-xl bg-white p-5 shadow">
        <h2 className="mb-3 font-bold text-indigo-700">科目別正答率（苦手順）</h2>
        <ResponsiveContainer width="100%" height={Math.max(300, bySubject.length * 32)}>
          <BarChart data={bySubject} layout="vertical" margin={{ left: 40, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" domain={[0, 100]} unit="%" />
            <YAxis type="category" dataKey="subject" width={200} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number) => [`${v}%`, "正答率"]} />
            <Bar dataKey="accuracy" fill="#4f46e5" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <table className="mt-4 w-full text-sm">
          <thead className="bg-slate-100 text-left">
            <tr>
              <th className="px-3 py-1.5">科目</th>
              <th className="px-3 py-1.5 text-right">解答数</th>
              <th className="px-3 py-1.5 text-right">正解数</th>
              <th className="px-3 py-1.5 text-right">正答率</th>
            </tr>
          </thead>
          <tbody>
            {bySubject.map((s) => (
              <tr key={s.subject} className="border-t border-slate-100">
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
        <p className="mt-2 text-xs text-slate-400">※ 本番の合格基準は総得点の約60%（+全科目群で得点）</p>
      </section>

      {timeline.length > 1 && (
        <section className="rounded-xl bg-white p-5 shadow">
          <h2 className="mb-3 font-bold text-indigo-700">正答率の推移</h2>
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
