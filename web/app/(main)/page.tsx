"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ReviewSubject = {
  subject: string;
  correct: number;
  total: number;
  wrongCount: number;
  everMissed: number;
  accuracy: number | null;
};
type ExamSummary = {
  thisMonth: string;
  thisMonthAttempts: number;
  thisMonthAccuracy: number;
  subjectsPracticed: number;
};
type NextAction = { action: "subject" | "mock" | "exam"; targetSubject: string | null; reason: string; href: string };

const ACTION_LABEL: Record<NextAction["action"], string> = { subject: "科目別演習", mock: "全科目演習", exam: "実戦模試" };

// 「おすすめの次の一手」はLLM呼び出しを伴うため、ホーム画面を開くたび（単なるリロードも
// 含む）に毎回呼ぶとトークンを浪費する。かといって時間で区切ると、短時間に何問も解いて
// 状況（弱点ストック・受験回数など）が変わった場合に反映が遅れてしまう。そこで、判断材料と
// なる状態のフィンガープリント（stateHash、lib/nextAction.tsで算出）をLLM呼び出し無しで
// 安く取得し、前回と一致する間はキャッシュ済みの結果を使い回す方式にする
const NEXT_ACTION_CACHE_KEY = "home_next_action_cache_v2";
type NextActionCache = NextAction & { stateHash: string };

function loadCachedNextAction(): NextActionCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(NEXT_ACTION_CACHE_KEY);
    return raw ? (JSON.parse(raw) as NextActionCache) : null;
  } catch {
    return null;
  }
}
function saveCachedNextAction(action: NextActionCache) {
  localStorage.setItem(NEXT_ACTION_CACHE_KEY, JSON.stringify(action));
}

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

// 科目別弱点マップの優先度。「わかっている弱点」より「まだ何もわからない科目」の方が
// リスクが高い（本番で不意に0点科目群を引く恐れがある）ため、未挑戦・データ不足を
// 既知の弱点より上位に表示する
type MapCategory = "untouched" | "lowConfidence" | "needsReview" | "confidentOk";
// これ未満の解答数では、正答率で判断すること自体の意味が薄いとみなす目安。
// 演習モードでは「正答率」より「解いた量」と「残り問題の絶対数」の方が重要
// （正答率が主役になるのは実力を測る実戦模試の役割）。review-summary APIの
// 直近件数の窓(RECENT_WINDOW=30)と揃えている
const CONFIDENCE_THRESHOLD = 30;

function categorize(s: ReviewSubject): MapCategory {
  if (s.total === 0) return "untouched";
  if (s.wrongCount > 0) return "needsReview";
  if (s.total < CONFIDENCE_THRESHOLD) return "lowConfidence";
  return "confidentOk";
}

function WeaknessRow({ s }: { s: ReviewSubject }) {
  const [showInfo, setShowInfo] = useState(false);
  const category = categorize(s);
  const cleared = Math.max(0, s.everMissed - s.wrongCount);
  const clearedRate = s.everMissed > 0 ? cleared / s.everMissed : 0;
  const volumeRate = Math.min(1, s.total / CONFIDENCE_THRESHOLD);

  // バーは「正答率」ではなく、その科目の演習でいま最も意味のある進捗を表す:
  // 既知の弱点はゴール（弱点ゼロ）までの克服率、データ不足はまず十分な量を
  // 解けているかの目安、克服済みは満タン、未挑戦は空
  let barPercent = 0;
  let barColor = "bg-stone-200";
  if (category === "needsReview") {
    barPercent = Math.round(clearedRate * 100);
    barColor = clearedRate < 0.34 ? "bg-red-500" : clearedRate < 0.67 ? "bg-amber-500" : "bg-green-500";
  } else if (category === "lowConfidence") {
    barPercent = Math.round(volumeRate * 100);
    barColor = "bg-amber-400";
  } else if (category === "confidentOk") {
    barPercent = 100;
    barColor = "bg-green-500";
  }

  const badge =
    category === "needsReview" ? (
      <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">残り{s.wrongCount}問</span>
    ) : category === "untouched" ? (
      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">未挑戦</span>
    ) : category === "lowConfidence" ? (
      <span className="flex shrink-0 items-center gap-1">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">データ不足</span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowInfo((v) => !v);
          }}
          aria-label="データ不足の説明を見る"
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[10px] font-bold leading-none text-amber-800"
        >
          ？
        </button>
      </span>
    ) : (
      <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">OK</span>
    );

  const subtext =
    category === "needsReview"
      ? `${s.everMissed}問中${cleared}問克服`
      : category === "untouched"
        ? "まだ解いていません"
        : category === "lowConfidence"
          ? `解答数${s.total}/${CONFIDENCE_THRESHOLD}問`
          : `解答数${s.total}問`;

  const clickable = category !== "confidentOk";
  const content = (
    <div className={`flex items-center gap-3 rounded-xl p-2.5 transition-colors ${clickable ? "bg-white shadow-warm-sm hover:bg-indigo-50" : "opacity-50"}`}>
      <span className="w-28 shrink-0 truncate text-sm text-stone-700 sm:w-36">{s.subject}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${barPercent}%` }} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {badge}
        <span className="text-[11px] text-stone-400">{subtext}</span>
      </div>
    </div>
  );
  if (category === "needsReview") {
    return (
      <Link href={`/quiz?mode=review&subject=${encodeURIComponent(s.subject)}`} className="block">
        {content}
      </Link>
    );
  }
  if (category === "untouched" || category === "lowConfidence") {
    return (
      <div>
        <Link href={`/quiz?mode=subject&subject=${encodeURIComponent(s.subject)}`} className="block">
          {content}
        </Link>
        {showInfo && category === "lowConfidence" && (
          <p className="mt-1 rounded-lg bg-amber-50 p-2 text-xs leading-relaxed text-amber-800">
            今は間違えたまま残っている問題はありませんが、解答数が{s.total}/{CONFIDENCE_THRESHOLD}問とまだ少なく、実力を正しく判断できません。あと{Math.max(0, CONFIDENCE_THRESHOLD - s.total)}問解答すると解消されます。未挑戦の科目と同じく優先して演習すべき科目です。
          </p>
        )}
      </div>
    );
  }
  return content;
}

export default function Dashboard() {
  const [reviewSubjects, setReviewSubjects] = useState<ReviewSubject[] | null>(null);
  const [everMissed, setEverMissed] = useState(0);
  const [totalWrong, setTotalWrong] = useState(0);
  const [examSummary, setExamSummary] = useState<ExamSummary | null>(null);
  const [examRemainingThisMonth, setExamRemainingThisMonth] = useState<number | null>(null);
  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [nextActionLoading, setNextActionLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = loadCachedNextAction();
    // まず状態のフィンガープリントだけを安く取得し、前回キャッシュ時と一致するなら
    // LLM呼び出し（/api/home/next-action）自体をスキップしてキャッシュをそのまま使う
    fetch("/api/home/next-action/state")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        if (cached && cached.stateHash === d.stateHash) {
          setNextAction(cached);
          return;
        }
        return fetch("/api/home/next-action")
          .then((r) => r.json())
          .then((fresh) => {
            if (!fresh.error) {
              setNextAction(fresh as NextActionCache);
              saveCachedNextAction(fresh as NextActionCache);
            }
          });
      })
      .catch(() => {
        // 状態チェック自体に失敗した場合は、直前のキャッシュがあればそれだけでも出しておく
        if (cached) setNextAction(cached);
      })
      .finally(() => setNextActionLoading(false));

    fetch("/api/quiz/review-summary")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setReviewSubjects(d.subjects ?? []);
        setEverMissed(d.everMissed ?? 0);
        setTotalWrong(d.totalWrong ?? 0);
      })
      .catch(() => setError("データの読み込みに失敗しました。時間をおいて再度お試しください。"));

    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setExamSummary(d.summary);
      })
      .catch(() => setError("データの読み込みに失敗しました。時間をおいて再度お試しください。"));

    fetch("/api/exam/state")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setExamRemainingThisMonth(d.remainingThisMonth ?? null);
      })
      .catch(() => {});
  }, []);

  const consumedPercent = everMissed > 0 ? Math.round((100 * (everMissed - totalWrong)) / everMissed) : null;
  // 表示優先度: 未挑戦・データ不足（まだ何もわからない＝本番で不意打ちを食らうリスク）
  // > 既知の弱点（対処法が明確）> 十分なデータがあってOKな科目（下に畳む）
  const untouched = (reviewSubjects ?? []).filter((s) => categorize(s) === "untouched");
  const lowConfidence = (reviewSubjects ?? []).filter((s) => categorize(s) === "lowConfidence");
  const needsReview = (reviewSubjects ?? []).filter((s) => categorize(s) === "needsReview");
  const confidentOk = (reviewSubjects ?? []).filter((s) => categorize(s) === "confidentOk");
  const SHOWN_CONFIDENT_OK = 4;
  const shownConfidentOk = confidentOk.slice(0, SHOWN_CONFIDENT_OK);
  const hiddenConfidentOkCount = confidentOk.length - shownConfidentOk.length;

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
          href="/quiz?mode=mock"
          className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <h2 className="font-bold text-violet-700">全科目演習</h2>
          <p className="mt-1 text-sm text-stone-600">全18科目を1問ずつ横断演習</p>
        </Link>
        <Link
          href="/quiz?mode=subject"
          className="rounded-2xl border-l-4 border-indigo-400 bg-white p-5 shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
        >
          <h2 className="font-bold text-indigo-700">科目別演習</h2>
          <p className="mt-1 text-sm text-stone-600">科目を選んで集中的に演習</p>
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
              <p className="mt-1 text-xs text-stone-400">※同一の問題を3回連続で正解すると克服したとみなします</p>
            </div>
          </div>
        )}
      </section>

      {/* 科目別弱点マップ */}
      {reviewSubjects && reviewSubjects.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <h2 className="mb-1 font-bold text-indigo-700">科目別弱点マップ</h2>
          <p className="mb-3 text-xs text-stone-400">
            まだ何もわからない科目・データが少ない科目を優先表示。タップすると、既知の弱点は復習モード、
            未挑戦・データ不足の科目は科目別演習が始まります。
          </p>
          <div className="space-y-1.5">
            {untouched.map((s) => (
              <WeaknessRow key={s.subject} s={s} />
            ))}
            {lowConfidence.map((s) => (
              <WeaknessRow key={s.subject} s={s} />
            ))}
            {needsReview.map((s) => (
              <WeaknessRow key={s.subject} s={s} />
            ))}
            {shownConfidentOk.map((s) => (
              <WeaknessRow key={s.subject} s={s} />
            ))}
          </div>
          {hiddenConfidentOkCount > 0 && (
            <p className="mt-2 text-xs text-stone-400">ほか{hiddenConfidentOkCount}科目は順調です</p>
          )}
          {reviewSubjects.length === 0 && <p className="text-sm text-stone-500">まだ演習データがありません。</p>}
        </section>
      )}

      {/* 実戦模試の実力（詳しい推移は成績タブへ、ここでは重複させず今の状態だけ） */}
      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="mb-3 font-bold text-indigo-700">実戦模試の実力</h2>
        {!examSummary || examSummary.subjectsPracticed === 0 ? (
          <p className="text-sm text-stone-500">まだ受験していません。</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              {examSummary.thisMonthAttempts > 0 ? (
                <>
                  <p className={`text-3xl font-bold ${examSummary.thisMonthAccuracy >= 60 ? "text-green-600" : "text-red-600"}`}>
                    {examSummary.thisMonthAccuracy}%
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {formatMonth(examSummary.thisMonth)}・{examSummary.thisMonthAttempts}問解答（合格ライン60%）
                  </p>
                </>
              ) : (
                <p className="text-sm text-stone-500">今月はまだ実戦模試を受けていません。</p>
              )}
              {examRemainingThisMonth !== null && (
                <p className="mt-1 text-xs text-stone-400">今月あと{examRemainingThisMonth}回受験可</p>
              )}
            </div>
            <Link href="/stats" className="text-sm font-medium text-indigo-700 underline underline-offset-2">
              得点率の推移を見る →
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
