"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EXAM_SUBJECT_COUNTS } from "@/lib/examFormat";

const SUBJECT_PART: Record<string, "common" | "specialized"> = Object.fromEntries(
  EXAM_SUBJECT_COUNTS.map((s) => [s.subject, s.part]),
);

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

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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
// リスクが高い（本番で不意に0点科目群を引く恐れがある）ため、未挑戦・データが薄い科目を
// 既知の弱点より上位に表示する
type MapCategory = "untouched" | "needsReview" | "confidentOk";
// これ未満の解答数では、正答率・弱点判定の意味が薄いとみなす絶対的な目安。
// review-summary APIの直近件数の窓(RECENT_WINDOW=30)と揃えている
const CONFIDENCE_THRESHOLD = 30;

function categorize(s: ReviewSubject): MapCategory {
  if (s.total === 0) return "untouched";
  if (s.wrongCount > 0) return "needsReview";
  return "confidentOk";
}

/**
 * 「解答数がまだ薄い」を示す独立フラグ。categorize()の弱点判定（間違いの有無）とは別軸で、
 * (a) 絶対的な最低ライン(CONFIDENCE_THRESHOLD問)に届いていない、(b) 他の科目と比べても
 * 相対的に少ない（全18科目の中央値の半分以下）、のいずれかを満たせばtrue。
 * 弱点マップは正答率ではなく「間違えたまま残っている問題の総数」で評価するものなので、
 * 解答数の少なさは判定の統計的信頼性の問題ではなく、単に「まだ試していない問題の中に
 * 見つかっていない弱点が隠れているかもしれない」というカバレッジの問題である。
 * 既知の弱点(赤バッジ)の有無に関わらず、その注意喚起として上にも重ねて表示する
 * （間違いの情報自体は隠さない）
 */
function isDataThin(s: ReviewSubject, medianTotal: number): boolean {
  if (s.total === 0) return false;
  return s.total < CONFIDENCE_THRESHOLD || s.total <= medianTotal / 2;
}

function WeaknessRow({ s, medianTotal }: { s: ReviewSubject; medianTotal: number }) {
  const [showDetail, setShowDetail] = useState(false);
  const category = categorize(s);
  const thin = isDataThin(s, medianTotal);
  const cleared = Math.max(0, s.everMissed - s.wrongCount);

  // バーは全カテゴリ共通で「解答数の蓄積度」を表す（0〜CONFIDENCE_THRESHOLD問で0→100%、
  // 克服済みは満タン）。以前はカテゴリごとに異なる指標（克服率・解答数比率など）を使って
  // いたため、科目によってバーの意味がバラバラで長さも比較しにくかった
  const barPercent = category === "confidentOk" ? 100 : Math.round(Math.min(1, s.total / CONFIDENCE_THRESHOLD) * 100);
  const barColor = category === "needsReview" ? "bg-red-400" : category === "untouched" ? "bg-stone-200" : "bg-green-500";

  const badge =
    category === "needsReview" ? (
      <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">残り{s.wrongCount}問</span>
    ) : category === "untouched" ? (
      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">未挑戦</span>
    ) : (
      <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">OK</span>
    );

  const clickable = category !== "confidentOk";
  const linkHref =
    category === "needsReview"
      ? `/quiz?mode=review&subject=${encodeURIComponent(s.subject)}`
      : `/quiz?mode=subject&subject=${encodeURIComponent(s.subject)}`;

  const row = (
    <div className={`flex items-center gap-2 rounded-xl p-2.5 transition-colors ${clickable ? "bg-white shadow-warm-sm hover:bg-indigo-50" : "opacity-50"}`}>
      <span className="w-28 shrink-0 truncate text-sm text-stone-700 sm:w-36">{s.subject}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${barPercent}%` }} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {thin && (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-400 text-[10px] font-bold leading-none text-white"
            title="解答数がまだ少なく、間違えた問題がまだ見つかっていないだけの可能性があります"
          >
            ！
          </span>
        )}
        {badge}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowDetail((v) => !v);
          }}
          aria-label="詳細を見る"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100"
        >
          <span className="text-xs">ⓘ</span>
        </button>
      </div>
    </div>
  );

  return (
    <div>
      {clickable ? (
        <Link href={linkHref} className="block">
          {row}
        </Link>
      ) : (
        row
      )}
      {showDetail && (
        <div className="mt-1 space-y-0.5 rounded-lg bg-stone-50 p-2 text-xs leading-relaxed text-stone-600">
          <p>解答数: {s.total}問</p>
          {s.everMissed > 0 && (
            <p>
              克服: {cleared}/{s.everMissed}問
            </p>
          )}
          {thin && (
            <p className="text-amber-700">
              解答数がまだ少なく（目安{CONFIDENCE_THRESHOLD}問、または他科目の解答数の中央値の半分）、プールの中の未着手の問題にまだ弱点が隠れている可能性があります。優先して演習することをおすすめします。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// 共通科目/専門科目の1セクション分。優先度（未挑戦・データが薄い科目 > 既知の弱点 > OK）は
// 全体と同じ考え方をセクション内で適用する
function WeaknessMapSection({ title, subjects, medianTotal }: { title: string; subjects: ReviewSubject[]; medianTotal: number }) {
  if (subjects.length === 0) return null;
  const untouched = subjects.filter((s) => categorize(s) === "untouched");
  const rest = subjects.filter((s) => categorize(s) !== "untouched");
  const thin = rest.filter((s) => isDataThin(s, medianTotal));
  const solid = rest.filter((s) => !isDataThin(s, medianTotal));
  const needsReview = solid.filter((s) => categorize(s) === "needsReview");
  const confidentOk = solid.filter((s) => categorize(s) === "confidentOk");
  const SHOWN_CONFIDENT_OK = 3;
  const shownConfidentOk = confidentOk.slice(0, SHOWN_CONFIDENT_OK);
  const hiddenConfidentOkCount = confidentOk.length - shownConfidentOk.length;
  const totalAnswered = subjects.reduce((sum, s) => sum + s.total, 0);
  return (
    <div>
      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-bold text-stone-500">
        {title}
        <span className="font-normal text-stone-400">計{totalAnswered}問解答</span>
      </h3>
      <div className="space-y-1.5">
        {untouched.map((s) => (
          <WeaknessRow key={s.subject} s={s} medianTotal={medianTotal} />
        ))}
        {thin.map((s) => (
          <WeaknessRow key={s.subject} s={s} medianTotal={medianTotal} />
        ))}
        {needsReview.map((s) => (
          <WeaknessRow key={s.subject} s={s} medianTotal={medianTotal} />
        ))}
        {shownConfidentOk.map((s) => (
          <WeaknessRow key={s.subject} s={s} medianTotal={medianTotal} />
        ))}
      </div>
      {hiddenConfidentOkCount > 0 && (
        <p className="mt-1.5 text-xs text-stone-400">ほか{hiddenConfidentOkCount}科目は順調です</p>
      )}
    </div>
  );
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
  // 弱点マップは共通科目/専門科目で分けて表示する（本番の午前/午後の区分と揃える）。
  // セクション内の優先度: 未挑戦・データ不足（まだ何もわからない＝本番で不意打ちを
  // 食らうリスク）> 既知の弱点（対処法が明確）> 十分なデータがあってOKな科目（下に畳む）
  const commonSubjects = (reviewSubjects ?? []).filter((s) => SUBJECT_PART[s.subject] === "common");
  const specializedSubjects = (reviewSubjects ?? []).filter((s) => SUBJECT_PART[s.subject] === "specialized");
  const totalAnsweredOverall = (reviewSubjects ?? []).reduce((sum, s) => sum + s.total, 0);
  const medianTotal = median((reviewSubjects ?? []).map((s) => s.total));

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
          <h2 className="mb-1 flex items-baseline gap-2 font-bold text-indigo-700">
            科目別弱点マップ
            <span className="text-xs font-normal text-stone-400">全体で計{totalAnsweredOverall}問解答</span>
          </h2>
          <p className="mb-3 text-xs text-stone-400">
            未挑戦・解答数が少ない科目（！マーク）を優先表示。タップすると、既知の弱点は
            復習モード、それ以外は科目別演習が始まります。ⓘで詳細を表示できます。
          </p>
          <div className="space-y-5">
            <WeaknessMapSection title="共通科目" subjects={commonSubjects} medianTotal={medianTotal} />
            <WeaknessMapSection title="専門科目" subjects={specializedSubjects} medianTotal={medianTotal} />
          </div>
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
