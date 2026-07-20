"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// 忘却曲線（エビングハウスの忘却曲線の考え方に基づく、実データではないイメージ図）。
// 「復習しない場合」は指数関数的に記憶保持率が下がり続けるが、「想起の庭で復習した場合」は
// 克服から14日後（想起の庭の対象になるタイミング）に思い出す機会があることで、その後の
// 減衰が緩やかになる ── という想起の庭の設計思想を視覚的に示す。
const REVIEW_DAY = 14;

function withoutReview(day: number): number {
  return Math.round(100 * Math.exp(-day / 12));
}
function withReview(day: number): number {
  if (day <= REVIEW_DAY) return Math.round(100 * Math.exp(-day / 12));
  const daysSinceReview = day - REVIEW_DAY;
  const retentionAtReview = 90; // 復習によって記憶が呼び戻される
  return Math.round(retentionAtReview * Math.exp(-daysSinceReview / 30));
}

const data = Array.from({ length: 61 }, (_, day) => ({
  day,
  withoutReview: withoutReview(day),
  withReview: withReview(day),
}));

const SERIES_LABEL: Record<string, string> = {
  withoutReview: "復習しない場合",
  withReview: "想起の庭で復習した場合",
};

export default function ForgettingCurve() {
  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ left: 0, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="day" tickFormatter={(d: number) => `${d}日`} tick={{ fontSize: 11 }} />
          <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={(v: number, name: string) => [`${v}%`, SERIES_LABEL[name] ?? name]}
            labelFormatter={(d: number) => `${d}日後`}
          />
          <Legend formatter={(value: string) => SERIES_LABEL[value] ?? value} wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine
            x={REVIEW_DAY}
            stroke="#059669"
            strokeDasharray="4 4"
            label={{ value: "想起の庭", position: "top", fill: "#059669", fontSize: 11 }}
          />
          <Line type="monotone" dataKey="withoutReview" stroke="#f87171" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="withReview" stroke="#059669" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-stone-400">※ 忘却曲線の考え方に基づくイメージ図（実データではありません）</p>
    </div>
  );
}
