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
    return <p className="text-stone-600">まだ解答記録がありません。演習すると科目別の成績が表示されます。</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">成績</h1>

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

      {timeline.length > 1 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
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
