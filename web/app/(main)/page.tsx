"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EXAM_SUBJECT_COUNTS } from "@/lib/examFormat";
import { getStoredProfile, profileScopedKey } from "@/lib/profile";
import ReportPopup from "./reports/ReportPopup";

const SUBJECT_PART: Record<string, "common" | "specialized"> = Object.fromEntries(
  EXAM_SUBJECT_COUNTS.map((s) => [s.subject, s.part]),
);

type ReviewSubject = {
  subject: string;
  total: number;
  wrongCount: number;
  everMissed: number;
  poolFull: boolean;
};
type ExamSummary = {
  thisMonth: string;
  thisMonthAttempts: number;
  thisMonthAccuracy: number;
  subjectsPracticed: number;
};
type NextAction = {
  action: "subject" | "review" | "mock" | "exam" | "garden";
  targetSubject: string | null;
  part: "common" | "specialized" | null;
  reason: string;
  href: string;
};

const ACTION_LABEL: Record<NextAction["action"], string> = {
  subject: "科目別演習",
  review: "復習モード",
  mock: "全科目演習",
  exam: "実戦模試",
  garden: "記憶の庭",
};

type PlanProgress = {
  reportId: number;
  planTotal: number;
  doneTotal: number;
  bySubject: { subject: string; target: number; done: number }[];
};

// 「おすすめの次の一手」はLLM呼び出しを伴うため、ホーム画面を開くたび（単なるリロードも
// 含む）に毎回呼ぶとトークンを浪費する。かといって時間で区切ると、短時間に何問も解いて
// 状況（弱点ストック・受験回数など）が変わった場合に反映が遅れてしまう。そこで、判断材料と
// なる状態のフィンガープリント（stateHash、lib/nextAction.tsで算出）をLLM呼び出し無しで
// 安く取得し、前回と一致する間はキャッシュ済みの結果を使い回す方式にする
const NEXT_ACTION_CACHE_KEY = "home_next_action_cache_v3";
type NextActionCache = NextAction & { stateHash: string };

function loadCachedNextAction(): NextActionCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(profileScopedKey(NEXT_ACTION_CACHE_KEY));
    return raw ? (JSON.parse(raw) as NextActionCache) : null;
  } catch {
    return null;
  }
}
function saveCachedNextAction(action: NextActionCache) {
  localStorage.setItem(profileScopedKey(NEXT_ACTION_CACHE_KEY), JSON.stringify(action));
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
// これ未満の解答数では、まだ試していない問題に弱点が隠れている可能性が高いとみなす
// 絶対的な目安（lib/nextAction.tsのCONFIDENCE_THRESHOLDと意図的に同じ値を独立に持つ）
const CONFIDENCE_THRESHOLD = 30;
// 科目ごとの出題プールの上限（lib/questionSupply.tsのSUBJECT_TARGETと同じ値）。
// サーバー専用のそちらは直接importできないためここでも独立に持つ。この問題数まで
// 生成し切り、かつ弱点が0件になったら「PERFECT」表示にする
const SUBJECT_TARGET = 200;

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
  // 出題プールが上限まで生成し切られ(poolFull)、かつ今は間違えたまま残っている問題が
  // 無い(confidentOk)状態。その科目で作られ得る問題を全て克服したという最終ゴールなので、
  // 普段の緑「OK」バッジとは別格の特別な見た目にする
  const isPerfect = category === "confidentOk" && s.poolFull;

  // 間違えたまま残っている問題がある科目(needsReview)は、バーを「これまで間違えた
  // 問題のうち、克服できた問題の割合」にする。克服が進むほど赤→黄→緑に変わり、
  // 見た目の変化がそのまま進捗の実感になるようにする。それ以外の科目は「解答数の
  // 蓄積度」（0〜CONFIDENCE_THRESHOLD問で0→100%）、克服済み・克服のしようが無い
  // (never missed)科目は満タン表示にする
  const clearedRate = s.everMissed > 0 ? cleared / s.everMissed : 1;
  const barPercent =
    category === "needsReview"
      ? Math.round(clearedRate * 100)
      : category === "confidentOk"
        ? 100
        : Math.round(Math.min(1, s.total / CONFIDENCE_THRESHOLD) * 100);
  const barColor = isPerfect
    ? "bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400"
    : category === "needsReview"
      ? clearedRate < 0.34
        ? "bg-red-500"
        : clearedRate < 0.67
          ? "bg-amber-500"
          : "bg-green-500"
      : category === "untouched"
        ? "bg-stone-200"
        : "bg-green-500";

  const badge =
    category === "needsReview" ? (
      <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">残り{s.wrongCount}問</span>
    ) : category === "untouched" ? (
      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">未挑戦</span>
    ) : isPerfect ? (
      <span className="shrink-0 rounded-full bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 px-2 py-0.5 text-xs font-extrabold text-amber-900 shadow-sm">
        ✨ PERFECT
      </span>
    ) : (
      <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">OK</span>
    );

  // 解答数が少ない科目(thin)は、間違えたまま残っている問題があっても復習ではなく
  // 科目別演習に誘導する。解答数が少ないうちは、既知の間違いを復習することより
  // まず母数を増やしてまだ見つかっていない弱点を洗い出すことを優先すべきため
  // （既知の弱点バッジ自体はそのまま表示し、事実は隠さない）
  const goReview = category === "needsReview" && !thin;
  const clickable = !(category === "confidentOk" && !thin);
  const linkHref = goReview
    ? `/quiz?mode=review&subject=${encodeURIComponent(s.subject)}`
    : `/quiz?mode=subject&subject=${encodeURIComponent(s.subject)}`;

  // 詳細ボタンは、科目行全体を包むLinkの「外」に置く（兄弟要素にする）。以前はLink(<a>)の
  // 内側にbuttonを入れ子にしており、HTML的に無効な構造（インタラクティブ要素の中に
  // インタラクティブ要素）だったため、特にタッチ環境でボタン側のタップがLinkのクリックとして
  // 誤判定され、詳細を見たいだけなのに演習が始まってしまう不具合の原因になっていた
  const linkContent = (
    <>
      {/* 科目名は可変長（短い「医学概論」〜長い「ソーシャルワークの理論と方法(専門)」まで）
          なので、固定幅のtruncateにはせずflex-1で余白を優先的に割り当て、進捗バーは
          あくまで補助的な装飾として小さめの固定幅にする（見切れて判別しづらくなるのを防ぐ） */}
      <span className="min-w-0 flex-1 truncate text-sm text-stone-700">{s.subject}</span>
      <div className="h-2 w-10 shrink-0 overflow-hidden rounded-full bg-stone-100 sm:w-16">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${barPercent}%` }} />
      </div>
      {badge}
    </>
  );

  const row = (
    <div
      className={`flex items-center gap-3 rounded-xl p-2.5 transition-colors ${
        clickable
          ? "bg-white shadow-warm-sm hover:bg-indigo-50"
          : isPerfect
            ? "bg-gradient-to-r from-amber-50 via-yellow-50 to-amber-50 shadow-warm-sm"
            : "opacity-50"
      }`}
    >
      {clickable ? (
        <Link href={linkHref} className="flex min-w-0 flex-1 items-center gap-2">
          {linkContent}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{linkContent}</div>
      )}
      {/* 詳細ボタン。以前は「解答数が薄い」の！マークと別に並んでいて紛らわしく
          誤タップも招いていたため1つに統合した。薄い場合は黄色で目立たせつつ、
          押すと詳細（解答数・克服数・薄いことの説明）が開く、という一貫した動作にする。
          見た目は小さくしつつ、タップ判定はpaddingで確保する（科目名の表示幅を優先するため） */}
      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        aria-label={thin ? "問題数が少ない科目の詳細を見る" : "詳細を見る"}
        title={thin ? "問題数がまだ少なく、まだ遭遇していない問題にも弱点が隠れている可能性があります" : undefined}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full p-1 font-serif text-xs italic transition-colors ${
          thin ? "bg-amber-400 font-bold text-white hover:bg-amber-500" : "border border-stone-300 text-stone-400 hover:bg-stone-100"
        }`}
      >
        i
      </button>
    </div>
  );

  return (
    <div>
      {row}
      {showDetail && (
        <div className="mt-1 space-y-0.5 rounded-lg bg-stone-50 p-2 text-xs leading-relaxed text-stone-600">
          <p>問題数: {s.total}問</p>
          {s.everMissed > 0 && (
            <p>
              克服: {cleared}/{s.everMissed}問
            </p>
          )}
          {isPerfect && (
            <p className="font-medium text-amber-700">
              ✨ この科目で作成され得る問題（全{SUBJECT_TARGET}問）をすべて克服しました！
            </p>
          )}
          {thin && (
            <p className="text-amber-700">
              問題数がまだ少なく（目安{CONFIDENCE_THRESHOLD}問、または他科目の問題数の中央値の半分）、まだ遭遇していない未知の問題が多く残っています。そこにまだ弱点が隠れている可能性があります。優先して演習することをおすすめします。
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
  // 表示順は実際にタップした時の行き先と揃える: 科目別演習に誘導される科目
  // （未挑戦・解答数が少ない科目）> 復習モードに誘導される科目（解答数は十分だが
  // 間違えた問題が残っている）> OK（下に畳む）
  const untouched = subjects.filter((s) => categorize(s) === "untouched");
  const thinOthers = subjects.filter((s) => categorize(s) !== "untouched" && isDataThin(s, medianTotal));
  const needsReview = subjects.filter((s) => categorize(s) === "needsReview" && !isDataThin(s, medianTotal));
  const confidentOk = subjects.filter((s) => categorize(s) === "confidentOk" && !isDataThin(s, medianTotal));
  const SHOWN_CONFIDENT_OK = 3;
  const shownConfidentOk = confidentOk.slice(0, SHOWN_CONFIDENT_OK);
  const hiddenConfidentOkCount = confidentOk.length - shownConfidentOk.length;
  const totalAnswered = subjects.reduce((sum, s) => sum + s.total, 0);
  return (
    <div>
      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-bold text-stone-500">
        {title}
        <span className="font-normal text-stone-400">問題数計{totalAnswered}問</span>
      </h3>
      <div className="space-y-1.5">
        {untouched.map((s) => (
          <WeaknessRow key={s.subject} s={s} medianTotal={medianTotal} />
        ))}
        {thinOthers.map((s) => (
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

type PendingResume = {
  href: string;
  label: string;
  kind: "mock" | "subject";
  subject: string | null;
  part: "common" | "specialized" | null;
} | null;

const ALLSUBJECTS_PART_LABEL: Record<"common" | "specialized", string> = { common: "共通", specialized: "専門" };

// 全科目演習・科目別演習はどちらも独自にlocalStorageへ進行中セッションを保存していて
// （それぞれのページ内で「続きから再開しますか？」を出す）、ホーム画面はそれとは別に
// 「前回途中だったものがある」こと自体をバナーで気づかせる役割と、おすすめの次の一手
// （/api/home/next-action）にこの状況を伝える役割を持つ。判定ロジックは各ページの
// 「unfinished」判定と揃える（キーやフィールド名が変わったら両方直すこと）
function checkPendingResume(): PendingResume {
  if (typeof window === "undefined") return null;
  // 全科目演習は共通科目/専門科目それぞれ独立したセッションを持つ（web/app/(main)/quiz/AllSubjectsQuiz.tsx参照）
  for (const part of ["common", "specialized"] as const) {
    try {
      const raw = localStorage.getItem(profileScopedKey(`quiz_session_allsubjects_v2_${part}`));
      if (raw) {
        const p = JSON.parse(raw) as { answers?: Record<string, unknown>; subjectOrder?: string[] };
        const answered = Object.keys(p.answers ?? {}).length;
        const total = (p.subjectOrder ?? []).length;
        if (total > 0 && answered < total) {
          return {
            href: `/quiz?mode=mock&part=${part}`,
            label: `全科目演習（${ALLSUBJECTS_PART_LABEL[part]}科目・${answered}/${total}問まで解答済み）`,
            kind: "mock",
            subject: null,
            part,
          };
        }
      }
    } catch {
      // 壊れたデータは無視する
    }
  }
  try {
    const raw = localStorage.getItem(profileScopedKey("quiz_session_subject_v1"));
    if (raw) {
      const p = JSON.parse(raw) as { records?: unknown[]; count?: number; subject?: string };
      const answered = (p.records ?? []).length;
      const count = p.count ?? 0;
      if (count > 0 && answered < count && p.subject) {
        return {
          href: "/quiz?mode=subject",
          label: `科目別演習「${p.subject}」（${answered}/${count}問まで解答済み）`,
          kind: "subject",
          subject: p.subject,
          part: null,
        };
      }
    }
  } catch {
    // 壊れたデータは無視する
  }
  return null;
}

export default function Dashboard() {
  const [reviewSubjects, setReviewSubjects] = useState<ReviewSubject[] | null>(null);
  const [everMissed, setEverMissed] = useState(0);
  const [totalWrong, setTotalWrong] = useState(0);
  const [examSummary, setExamSummary] = useState<ExamSummary | null>(null);
  const [examRemainingThisMonth, setExamRemainingThisMonth] = useState<number | null>(null);
  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [nextActionLoading, setNextActionLoading] = useState(true);
  const [planProgress, setPlanProgress] = useState<PlanProgress | null>(null);
  const [showAllPlanSubjects, setShowAllPlanSubjects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const profile = getStoredProfile();
    // ProfileGateがprofile未確定の間はこの画面自体を描画しないため通常は必ず値が
    // 入っているが、念のための防御。
    if (!profile) return;
    const profileQuery = `profile=${profile}`;

    const cached = loadCachedNextAction();
    // 前回途中で終えた演習があれば、その情報を「おすすめの次の一手」にも伝える
    // （computeNextActionがこれを最優先で提案するため、バナーとの言動が揃う）
    const pending = checkPendingResume();
    const pendingQuery = pending
      ? `&pendingKind=${pending.kind}&pendingLabel=${encodeURIComponent(pending.label)}${
          pending.subject ? `&pendingSubject=${encodeURIComponent(pending.subject)}` : ""
        }${pending.part ? `&pendingPart=${pending.part}` : ""}`
      : "";
    // まず状態のフィンガープリントだけを安く取得し、前回キャッシュ時と一致するなら
    // LLM呼び出し（/api/home/next-action）自体をスキップしてキャッシュをそのまま使う
    fetch(`/api/home/next-action/state?${profileQuery}${pendingQuery}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        if (cached && cached.stateHash === d.stateHash) {
          setNextAction(cached);
          return;
        }
        return fetch(`/api/home/next-action?${profileQuery}${pendingQuery}`)
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

    fetch(`/api/quiz/review-summary?${profileQuery}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setReviewSubjects(d.subjects ?? []);
        setEverMissed(d.everMissed ?? 0);
        setTotalWrong(d.totalWrong ?? 0);
      })
      .catch(() => setError("データの読み込みに失敗しました。時間をおいて再度お試しください。"));

    fetch(`/api/stats?${profileQuery}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setExamSummary(d.summary);
      })
      .catch(() => setError("データの読み込みに失敗しました。時間をおいて再度お試しください。"));

    fetch(`/api/exam/state?${profileQuery}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setExamRemainingThisMonth(d.remainingThisMonth ?? null);
      })
      .catch(() => {});

    fetch(`/api/reports/plan-progress?${profileQuery}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.error && d.planTotal !== undefined) setPlanProgress(d);
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
      <ReportPopup />
      {/* 前回途中で終えた演習がある場合、専用バナーは出さず「おすすめの次の一手」に
          一本化する（computeNextActionがpendingResumeを最優先で必ず提案するため、
          別のバナーを並べると同じ内容が二重に表示されてしまう） */}
      {!nextActionLoading && nextAction && (
        <section className="rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 p-5 text-white shadow-warm">
          <p className="text-xs font-medium text-indigo-100">おすすめの次の一手</p>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-lg font-bold">
                {ACTION_LABEL[nextAction.action]}
                {nextAction.targetSubject ? `：${nextAction.targetSubject}` : ""}
                {nextAction.part ? `：${nextAction.part === "common" ? "共通科目" : "専門科目"}` : ""}
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

      {/* 今月の学習プラン（振り返りレポートが合格基準・本番日から逆算して算出した数値目標の
          消化状況）。まだレポートが一度も発行されていない場合は表示しない */}
      {planProgress && planProgress.planTotal > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-warm">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-indigo-700">今月の学習プラン</h2>
            <Link
              href={`/reports/${planProgress.reportId}?profile=${getStoredProfile()}`}
              className="text-xs text-stone-400 underline underline-offset-2"
            >
              振り返りレポートを見る
            </Link>
          </div>
          <p className="mt-1 text-sm text-stone-600">
            {planProgress.doneTotal} / {planProgress.planTotal}問
          </p>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-stone-100">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${Math.min(100, Math.round((100 * planProgress.doneTotal) / planProgress.planTotal))}%` }}
            />
          </div>

          {/* 「何をすれば進むか」が一目でわかるよう、未達の科目だけを少数厳選して出す
              （全科目分の詳細は振り返りレポート側にあるため、ここでは詳しくしすぎない） */}
          {(() => {
            const remaining = planProgress.bySubject.filter((s) => s.done < s.target).sort((a, b) => b.target - b.done - (a.target - a.done));
            const SHOWN = 4;
            const shown = showAllPlanSubjects ? remaining : remaining.slice(0, SHOWN);
            if (remaining.length === 0) {
              return <p className="mt-3 text-sm font-medium text-emerald-600">🎉 今月の目標科目はすべて達成しました</p>;
            }
            return (
              <div className="mt-3 space-y-1.5">
                {shown.map((s) => (
                  <div key={s.subject} className="flex items-center gap-2">
                    {/* 科目別弱点マップの科目名表示（本ファイル内のWeaknessRow）と同じ
                        「flex-1のtruncate＋バーは補助的な固定幅」の考え方に揃える
                        （ダッシュボード内で科目名の文字サイズ・省略のされ方が場所によって
                        違うと見た目がちぐはぐになるため） */}
                    <span className="min-w-0 flex-1 truncate text-sm text-stone-600">{s.subject}</span>
                    <div className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-stone-100 sm:w-16">
                      <div
                        className="h-full rounded-full bg-indigo-400"
                        style={{ width: `${Math.min(100, Math.round((100 * s.done) / s.target))}%` }}
                      />
                    </div>
                    <span className="w-12 shrink-0 text-right text-xs text-stone-500">
                      {s.done}/{s.target}
                    </span>
                  </div>
                ))}
                {remaining.length > SHOWN && (
                  <button
                    type="button"
                    onClick={() => setShowAllPlanSubjects((v) => !v)}
                    className="text-xs font-medium text-indigo-600 underline underline-offset-2"
                  >
                    {showAllPlanSubjects ? "閉じる" : `+ ほか${remaining.length - SHOWN}科目を表示`}
                  </button>
                )}
              </div>
            );
          })()}
        </section>
      )}

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
            <span className="text-xs font-normal text-stone-400">全体の問題数計{totalAnsweredOverall}問</span>
          </h2>
          <p className="mb-3 text-xs text-stone-400">
            未挑戦・問題数が少ない科目（ⓘが黄色）は科目別演習、問題数が十分で間違えた
            問題が残っている科目は復習モードが始まります。ⓘで問題数・克服数を確認できます。
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
