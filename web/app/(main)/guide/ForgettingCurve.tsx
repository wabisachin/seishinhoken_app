"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// エビングハウスの忘却曲線の実験値（節約法による保持率。Ebbinghaus (1885)、および
// Murre & Dros (2015, PLOS ONE)による追試で報告されている代表的な数値）。
// 「復習しない場合」はこの実測値そのものを使う（区間の間は直線補間のみで、新しい値の
// 創作はしていない）。想起の庭で14日後に想起（正解）できると、その瞬間に保持率が
// 100%へ戻る（スパイクは1回だけ）。その後の下がり方は「復習しない場合」と同じ形の
// カーブをそのまま繰り返すのではなく、意図的にゆるやかにしてある。これは、一度でも
// 想起に成功すると記憶がより忘れにくくなる（スペーシング効果・想起のたびに記憶が
// 定着していく効果）という広く知られた現象をイメージ化したもので、この「ゆるやかさ」
// 自体の具体的な数値は実測データではない。
const REVIEW_DAY = 14;

// day: 経過日数（20分・1時間・9時間は日に換算）, retention: 保持率(%)の実測値
const REAL_FORGETTING_POINTS: { day: number; retention: number }[] = [
  { day: 0, retention: 100 },
  { day: 20 / 1440, retention: 58 }, // 20分後
  { day: 1 / 24, retention: 44 }, // 1時間後
  { day: 9 / 24, retention: 36 }, // 9時間後
  { day: 1, retention: 34 }, // 1日後
  { day: 2, retention: 28 }, // 2日後
  { day: 6, retention: 25 }, // 6日後
  { day: 31, retention: 21 }, // 31日後
];

/** 実測値どうしの直線補間のみ（区間外は最初/最後の実測値で頭打ち）。新しい数値の創作はしない。 */
function withoutReviewAt(day: number): number {
  if (day <= 0) return 100;
  for (let i = 1; i < REAL_FORGETTING_POINTS.length; i++) {
    const prev = REAL_FORGETTING_POINTS[i - 1];
    const cur = REAL_FORGETTING_POINTS[i];
    if (day <= cur.day) {
      const ratio = (day - prev.day) / (cur.day - prev.day);
      return prev.retention + (cur.retention - prev.retention) * ratio;
    }
  }
  return REAL_FORGETTING_POINTS[REAL_FORGETTING_POINTS.length - 1].retention;
}

// 復習後に「同じ形のカーブに戻って忘れていく」のではなく、想起に成功したことで記憶が
// 定着し、同じ時間が経っても失う保持率がこの割合まで小さくなる、というイメージの
// 簡略化（実測値ではない）。0.55なら「本来失うはずだった分の55%しか実際には失わない」
const SECOND_RECALL_FORGETTING_RATIO = 0.55;

function withReviewAt(day: number): number {
  if (day < REVIEW_DAY) return withoutReviewAt(day);
  const elapsedSinceRecall = day - REVIEW_DAY;
  const forgottenIfNoBoost = 100 - withoutReviewAt(elapsedSinceRecall);
  return 100 - forgottenIfNoBoost * SECOND_RECALL_FORGETTING_RATIO;
}

const CHART_MAX_DAY = 31;
const data = Array.from({ length: CHART_MAX_DAY + 1 }, (_, day) => ({
  day,
  withoutReview: Math.round(withoutReviewAt(day)),
  withReview: Math.round(withReviewAt(day)),
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
            label={{ value: "想起の庭で再テスト", position: "top", fill: "#059669", fontSize: 11 }}
          />
          <Line type="linear" dataKey="withoutReview" stroke="#f87171" strokeWidth={2} dot={false} />
          <Line type="linear" dataKey="withReview" stroke="#059669" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-stone-400">
        ※「復習しない場合」はエビングハウスの実験値（節約法）。「想起の庭で復習した場合」は、
        14日後に想起の庭で正解した後、記憶が定着してより忘れにくくなる様子をイメージ化した
        図で、下がり方の緩やかさ自体は実測データではありません
      </p>
    </div>
  );
}
