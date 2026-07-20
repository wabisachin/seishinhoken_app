"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Question } from "@/lib/types";
import { getStoredProfile, profileScopedKey } from "@/lib/profile";
import { subjectsForPart, type ExamPart } from "@/lib/examFormat";
import ExplanationList from "./ExplanationList";
import { scrollToTop } from "./scrollToTop";

const STORAGE_KEY_PREFIX = "quiz_session_allsubjects_v2";
// 1問を取得するための、1問あたりの生成リトライ上限
// （科目別演習と同じ /api/quiz/next を使っており、却下が続く場合の保険も同じ考え方）
const MAX_NEXT_ATTEMPTS = 15;

type Answer = { selected: number[]; isCorrect: boolean };
type Persisted = {
  part: ExamPart;
  subjectOrder: string[];
  questions: Question[];
  answers: Record<number, Answer>;
  currentIndex: number;
  // 今の問題を解答済みで解説を表示中か、まだ解答前か。resume()でどちらの画面に
  // 戻すかを決めるために使う（無いと常に「answering」に戻ってしまい、解説を見ていた
  // 問題の解答状況とちぐはぐになる）
  phase: "answering" | "explaining";
  savedAt: number;
};

function storageKey(part: ExamPart) {
  return `${STORAGE_KEY_PREFIX}_${part}`;
}
function loadPersisted(part: ExamPart): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(profileScopedKey(storageKey(part)));
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}
function savePersisted(p: Persisted) {
  localStorage.setItem(profileScopedKey(storageKey(p.part)), JSON.stringify(p));
}
function clearPersisted(part: ExamPart) {
  localStorage.removeItem(profileScopedKey(storageKey(part)));
}

async function requestNextQuestion(
  subject: string,
  excludeIds: number[],
): Promise<{ question: Question | null; exhausted: boolean; isNew: boolean }> {
  const res = await fetch("/api/quiz/next", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, excludeIds, profile: getStoredProfile() ?? "self" }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return { question: (d.question as Question | null) ?? null, exhausted: !!d.exhausted, isNew: !!d.isNew };
}

/** 全科目演習も科目別演習と全く同じロジック（questionSupply.ts の getOrGenerateNext）で1問を取得する。 */
async function fetchOneQuestion(
  subject: string,
  onAttempt: ((n: number) => void) | null,
): Promise<{ question: Question; isNew: boolean } | null> {
  for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS; attempt++) {
    const { question, exhausted, isNew } = await requestNextQuestion(subject, []);
    if (question) return { question, isNew };
    if (exhausted) return null;
    onAttempt?.(attempt + 1);
  }
  throw new Error(`「${subject}」の出題準備に時間がかかりすぎています。時間をおいて再度お試しください。`);
}

/** Fisher-Yatesシャッフル。破壊的変更を避けるため新しい配列を返す。 */
function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchSubjectOrder(part: ExamPart): Promise<string[]> {
  const res = await fetch("/api/subjects");
  const d = await res.json();
  const subjects = (d.subjects ?? []) as { subject: string; kind: string | null; taxonomy_items: number }[];
  const available = new Set(subjects.filter((s) => s.taxonomy_items > 0).map((s) => s.subject));
  const partSubjects = subjectsForPart(part)
    .map((s) => s.subject)
    .filter((s) => available.has(s));
  // 毎回同じ並びで出題すると、後半の科目ばかり時間切れ・後回しになりがちで
  // 単調にもなるため、演習を始めるたびにシャッフルして出題順を変える
  return shuffleArray(partSubjects);
}

type Phase =
  | "part-select"
  | "checking"
  | "resume-prompt"
  | "loading"
  | "generating"
  | "answering"
  | "explaining"
  | "done"
  | "empty";

const PART_LABEL: Record<ExamPart, string> = { common: "共通科目", specialized: "専門科目" };

/**
 * 共通科目(12科目)・専門科目(6科目)のどちらかを選び、その科目群を1問ずつ横断で
 * 出題する。科目別演習・模試と同じく1問ずつ解答→解説を見てから次へ進む流れで、
 * 最後まで解き終えたら正答数のサマリーを表示する。全分野を横断して満遍なく触れる
 * ことが目的のため、科目別演習のような小単元別の詳しい結果レポートは持たない
 * （「未知の問題への対応力」の詳しい計測は実戦模試の役割）。
 */
export default function AllSubjectsQuiz({ initialPart }: { initialPart: ExamPart | null }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(initialPart ? "checking" : "part-select");
  const [part, setPart] = useState<ExamPart | null>(initialPart);
  const [subjectOrder, setSubjectOrder] = useState<string[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [draft, setDraft] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<Persisted | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generatingAttempt, setGeneratingAttempt] = useState(0);
  // 科目ごとに1回だけ取得を開始し、結果(または進行中のPromise)をキャッシュする。
  // 演習が始まったらバックグラウンドのランナーが最後の科目まで順番に生成を進め続けるため、
  // ユーザーが今の問題を解いている間に何問も先まで用意が進む。
  const oneCacheRef = useRef<Map<string, Promise<{ question: Question; isNew: boolean } | null>>>(new Map());
  const runnerActiveRef = useRef(false);
  const cancelledRef = useRef(false);
  // 今回のセッションで「本人が一度も解答したことがない」状態で出題された問題のID集合。
  // NEWバッジ表示用（リロードで消える表示上のフラグ。永続化はしない）。
  const [newQuestionIds, setNewQuestionIds] = useState<Set<number>>(new Set());
  function markNew(id: number) {
    setNewQuestionIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  function ensureOneStarted(
    subject: string,
    onAttempt: ((n: number) => void) | null = null,
  ): Promise<{ question: Question; isNew: boolean } | null> {
    let p = oneCacheRef.current.get(subject);
    if (!p) {
      p = fetchOneQuestion(subject, onAttempt).catch((e) => {
        oneCacheRef.current.delete(subject);
        throw e;
      });
      oneCacheRef.current.set(subject, p);
    }
    return p;
  }

  async function runBackgroundRunner(order: string[], startIndex: number) {
    if (runnerActiveRef.current) return;
    runnerActiveRef.current = true;
    for (let i = startIndex; i < order.length; i++) {
      if (cancelledRef.current) break;
      try {
        await ensureOneStarted(order[i]);
      } catch {
        // 失敗はここでは無視する。実際にその問題へ進む時にforeground側が再試行・エラー表示する
      }
    }
    runnerActiveRef.current = false;
  }

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // 問題の切り替わり（解答して解説を表示する／次の問題へ進む）のたびに、必ず
  // ページ先頭から読み始められるようにする。個々のsubmitAnswer()/nextQuestion()呼び出し側で
  // scrollToTop()を呼び忘れる経路が生まれないよう、表示中のphase・問題番号の変化
  // そのものをトリガーにする一元的な仕組みにしている（web/app/(main)/quiz/page.tsxと同じ考え方）。
  useEffect(() => {
    if (phase === "answering" || phase === "explaining") scrollToTop();
  }, [phase, currentIndex]);

  useEffect(() => {
    if (!part) return;
    const persisted = loadPersisted(part);
    // 「読み込み済みの問題数」ではなく「科目群の全問数」を基準にする。読み込み済み分を
    // 解答し終えた直後（explaining画面）は読み込み済み数=解答数になるが、全体は
    // まだ終わっていないため、これをunfinished=falseと誤判定してリロード時に
    // startFresh()で最初からやり直しになってしまっていた
    const unfinished = persisted && Object.keys(persisted.answers).length < persisted.subjectOrder.length;
    if (unfinished) {
      setPendingResume(persisted);
      setPhase("resume-prompt");
    } else {
      void startFresh(part);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part]);

  function choosePart(p: ExamPart) {
    setPart(p);
    router.replace(`/quiz?mode=mock&part=${p}`, { scroll: false });
    setPhase("checking");
  }

  async function startFresh(p: ExamPart) {
    clearPersisted(p);
    // 「もう一度」で再スタートした場合、前回分の取得済み/取得中Promiseが残っていると
    // 同じ問題がキャッシュから返ってしまう（サーバー側の未出題判定を素通りしてしまう）ため、
    // 出題順をシャッフルし直すのと合わせてキャッシュも必ずクリアする
    oneCacheRef.current.clear();
    setPhase("loading");
    setError(null);
    setGeneratingAttempt(0);
    try {
      const order = await fetchSubjectOrder(p);
      if (order.length === 0) {
        setError("出題できる科目がありません。");
        setPhase("empty");
        return;
      }
      setSubjectOrder(order);
      const r = await ensureOneStarted(order[0], (n) => {
        setPhase("loading");
        setGeneratingAttempt(n);
      });
      if (!r) {
        setError("出題できる問題がまだありません。科目別演習で問題を生成してから試してください。");
        setPhase("empty");
        return;
      }
      if (r.isNew) markNew(r.question.id);
      setQuestions([r.question]);
      setAnswers({});
      setCurrentIndex(0);
      setDraft([]);
      savePersisted({ part: p, subjectOrder: order, questions: [r.question], answers: {}, currentIndex: 0, phase: "answering", savedAt: Date.now() });
      setPhase("answering");
      void runBackgroundRunner(order, 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("empty");
    }
  }

  function resume() {
    if (!pendingResume) return;
    setSubjectOrder(pendingResume.subjectOrder);
    setQuestions(pendingResume.questions);
    setAnswers(pendingResume.answers);
    setCurrentIndex(pendingResume.currentIndex);
    setDraft([]);
    setPhase(pendingResume.phase ?? "answering");
    void runBackgroundRunner(pendingResume.subjectOrder, pendingResume.questions.length);
  }

  // 「新しく始める」ではなく、途中状態を消してダッシュボードに戻るだけにする。
  // ここで新しい演習を自動的に始めてしまうと、演習自体をやめたいユーザーにも
  // 何かを新しく始めることを強いてしまうため
  function discardAndDashboard() {
    if (part) clearPersisted(part);
    setPendingResume(null);
    router.push("/");
  }

  const currentQuestion = questions[currentIndex] ?? null;

  function toggle(q: Question, n: number) {
    setDraft((prev) => {
      const maxSelect = q.question_type === "multi" ? 2 : 1;
      let next: number[];
      if (prev.includes(n)) next = prev.filter((x) => x !== n);
      else if (maxSelect === 1) next = [n];
      else next = prev.length < maxSelect ? [...prev, n] : prev;
      return next;
    });
  }

  const requiredSelect = (q: Question) => (q.question_type === "multi" ? 2 : 1);
  const canProceed = !!currentQuestion && draft.length === requiredSelect(currentQuestion);
  const isLastQuestion = currentIndex + 1 >= subjectOrder.length;
  const answeredCount = Object.keys(answers).length;
  const correctCount = Object.values(answers).filter((a) => a.isCorrect).length;

  async function submitAnswer() {
    if (!currentQuestion) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_id: currentQuestion.id, selected: draft, mode: "mock", profile: getStoredProfile() ?? "self" }),
      });
      const d = await res.json();
      const nextAnswers = { ...answers, [currentQuestion.id]: { selected: draft, isCorrect: !!d.is_correct } };
      setAnswers(nextAnswers);
      if (part) {
        savePersisted({
          part,
          subjectOrder,
          questions,
          answers: nextAnswers,
          currentIndex,
          phase: "explaining",
          savedAt: Date.now(),
        });
      }
      setPhase("explaining");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function nextQuestion() {
    if (!part) return;
    if (isLastQuestion) {
      clearPersisted(part);
      setPhase("done");
      return;
    }
    setError(null);
    setPhase("loading");
    setGeneratingAttempt(0);
    try {
      const nextIndex = currentIndex + 1;
      // バックグラウンドランナーが既に用意できていれば即座に返る。まだなら
      // （ユーザーが解答が早く、ランナーがまだそこまで追いついていない場合）ここで待つ
      const r = await ensureOneStarted(subjectOrder[nextIndex], (n) => {
        setPhase("generating");
        setGeneratingAttempt(n);
      });
      if (!r) {
        // その科目の在庫が尽きて生成もできなかった場合は、この科目群の演習はここで
        // 打ち切りにする（残りの科目を飛ばして続けても不自然なため）
        clearPersisted(part);
        setPhase("done");
        return;
      }
      if (r.isNew) markNew(r.question.id);
      const nextQuestions = [...questions, r.question];
      setQuestions(nextQuestions);
      setCurrentIndex(nextIndex);
      setDraft([]);
      savePersisted({ part, subjectOrder, questions: nextQuestions, answers, currentIndex: nextIndex, phase: "answering", savedAt: Date.now() });
      setPhase("answering");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("explaining");
    }
  }

  if (phase === "part-select") {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">全科目演習</h1>
        <p className="text-sm text-stone-600">共通科目・専門科目のどちらを演習しますか？</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            onClick={() => choosePart("common")}
            className="rounded-2xl border-l-4 border-indigo-400 bg-white p-5 text-left shadow-warm transition-all hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-indigo-700">共通科目</h2>
            <p className="mt-1 text-sm text-stone-600">12科目を1問ずつ横断演習</p>
          </button>
          <button
            onClick={() => choosePart("specialized")}
            className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 text-left shadow-warm transition-all hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-violet-700">専門科目</h2>
            <p className="mt-1 text-sm text-stone-600">6科目を1問ずつ横断演習</p>
          </button>
        </div>
      </div>
    );
  }

  if (phase === "checking") return null;

  if (phase === "resume-prompt" && pendingResume) {
    const done = Object.keys(pendingResume.answers).length;
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">全科目演習（{PART_LABEL[pendingResume.part]}）</h1>
        <div className="rounded-2xl bg-amber-50 p-5 shadow-warm">
          <p className="text-sm text-amber-800">
            前回途中だった演習があります（{done} / {pendingResume.subjectOrder.length} 問まで解答済み）。続きから再開しますか？
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-3">
            <button
              onClick={resume}
              className="min-h-12 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              続きから再開する
            </button>
            <button
              onClick={discardAndDashboard}
              className="min-h-12 rounded-xl border border-stone-300 px-4 py-3 text-sm text-stone-600 transition-colors hover:bg-stone-100"
            >
              やめてダッシュボードに戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "loading") return <p>出題を準備中...</p>;

  if (phase === "generating") {
    return (
      <div className="space-y-3">
        <p className="rounded-xl bg-indigo-50 p-4 text-sm text-indigo-800">
          次の科目の問題を生成中です。しばらくお待ちください...
          <br />
          <span className="text-xs text-indigo-600">
            1回の生成に20〜60秒ほどかかることがあります（{generatingAttempt} / {MAX_NEXT_ATTEMPTS} 回目）
          </span>
        </p>
      </div>
    );
  }

  if (phase === "empty") {
    return (
      <div className="space-y-4">
        <p className="rounded bg-amber-100 p-3 text-sm text-amber-800">{error}</p>
        <Link href="/" className="inline-flex min-h-12 items-center rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700">
          ダッシュボードへ
        </Link>
      </div>
    );
  }

  if (phase === "done") {
    const total = answeredCount;
    const pct = total > 0 ? Math.round((100 * correctCount) / total) : 0;
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">お疲れさまでした</h1>
        <div className="rounded-2xl bg-white p-6 text-center shadow-warm">
          <p className="text-3xl font-bold text-indigo-700">
            {total}問中{correctCount}問正解
          </p>
          <p className="mt-1 text-sm text-stone-500">正答率{pct}%</p>
          <p className="mt-3 text-sm text-stone-500">
            間違えた問題は自動的に復習モードに追加されています。詳しい対応力の計測は実戦模試をご利用ください。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          <button
            onClick={() => part && void startFresh(part)}
            className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
          >
            もう一度
          </button>
          <Link href="/" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-indigo-600 px-5 py-3 font-medium text-indigo-700 transition-colors hover:bg-indigo-50">
            ダッシュボードへ
          </Link>
        </div>
      </div>
    );
  }

  if (!currentQuestion || !part) return null;

  // --- explaining: 解答した1問の解答・解説を表示 ---
  if (phase === "explaining") {
    const a = answers[currentQuestion.id];
    if (!a) return null;
    return (
      <div className="space-y-4 pb-24 sm:pb-0">
        <h1 className="text-lg font-bold">全科目演習（{PART_LABEL[part]}）</h1>
        <ProgressBar answered={answeredCount} total={subjectOrder.length} />
        <div className="rounded-2xl bg-white p-4 shadow-warm sm:p-5">
          <div className="mb-2 flex items-center gap-2 text-xs text-stone-400">
            <span className="rounded bg-stone-200 px-2 py-0.5">{currentQuestion.subject}</span>
            {newQuestionIds.has(currentQuestion.id) && (
              <span className="rounded bg-emerald-100 px-2 py-0.5 font-bold text-emerald-700">NEW</span>
            )}
          </div>
          <div className="mb-2 flex items-start gap-2">
            <span className={`shrink-0 font-bold ${a.isCorrect ? "text-green-600" : "text-red-600"}`}>
              {a.isCorrect ? "○" : "×"}
            </span>
            <div>
              {currentQuestion.case_text && (
                <p className="mb-1 rounded bg-stone-50 p-2 text-sm leading-relaxed">
                  <span className="mr-1 font-bold">〔事例〕</span>
                  {currentQuestion.case_text}
                </p>
              )}
              <p className="text-base font-medium leading-relaxed">{currentQuestion.stem}</p>
            </div>
          </div>
          <ol className="mt-3 space-y-2">
            {currentQuestion.options.map((opt, oi) => {
              const n = oi + 1;
              const isAnswer = currentQuestion.correct.includes(n);
              const chosen = a.selected.includes(n);
              let style = "border-stone-200 bg-white opacity-70";
              if (isAnswer) style = "border-green-500 bg-green-50";
              else if (chosen) style = "border-red-400 bg-red-50";
              return (
                <li key={n} className={`rounded-xl border p-3 text-sm leading-relaxed ${style}`}>
                  <span className="mr-2 font-bold">{n}</span>
                  {opt}
                  {isAnswer && <span className="ml-2 text-green-600">✓ 正答</span>}
                  {chosen && !isAnswer && <span className="ml-2 text-red-500">あなたの解答</span>}
                </li>
              );
            })}
          </ol>
          <ExplanationList
            questionId={currentQuestion.id}
            explanations={currentQuestion.explanations}
            correct={currentQuestion.correct}
            citations={currentQuestion.citations}
            keyPoints={currentQuestion.key_points}
            variant="inline"
          />
        </div>
        <div
          className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 p-4 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
        >
          <button
            onClick={nextQuestion}
            className="min-h-12 w-full rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-700 sm:w-auto"
          >
            {isLastQuestion ? "終了する" : "次の問題へ"}
          </button>
        </div>
        {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  // --- answering: 1問表示、解答後にその場で解説を表示 ---
  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      <h1 className="text-lg font-bold">全科目演習（{PART_LABEL[part]}）</h1>
      <ProgressBar answered={answeredCount} total={subjectOrder.length} />

      <div className="rounded-2xl bg-white p-4 shadow-warm sm:p-5">
        <div className="mb-2 flex items-center gap-2 text-xs text-stone-400">
          <span className="rounded bg-stone-200 px-2 py-0.5">{currentQuestion.subject}</span>
          {newQuestionIds.has(currentQuestion.id) && (
            <span className="rounded bg-emerald-100 px-2 py-0.5 font-bold text-emerald-700">NEW</span>
          )}
          <span>{currentQuestion.question_type === "multi" ? "2つ選択" : "1つ選択"}</span>
        </div>
        {currentQuestion.case_text && (
          <div className="mb-3 rounded bg-stone-50 p-3 text-sm leading-relaxed">
            <span className="mr-1 font-bold">〔事例〕</span>
            {currentQuestion.case_text}
          </div>
        )}
        <p className="text-base font-medium leading-relaxed">{currentQuestion.stem}</p>
        <div className="mt-3 space-y-2">
          {currentQuestion.options.map((opt, i) => {
            const n = i + 1;
            const chosen = draft.includes(n);
            return (
              <button
                key={n}
                onClick={() => toggle(currentQuestion, n)}
                className={`block min-h-12 w-full rounded-xl border p-3.5 text-left text-[15px] leading-snug transition-colors sm:text-sm ${
                  chosen ? "border-indigo-500 bg-indigo-50" : "border-stone-200 bg-white hover:bg-stone-50"
                }`}
              >
                <span className="mr-2 font-bold">{n}</span>
                {opt}
              </button>
            );
          })}
        </div>
        {draft.length > 0 && draft.length < requiredSelect(currentQuestion) && (
          <p className="mt-2 text-sm font-medium text-amber-700">
            この問題は{requiredSelect(currentQuestion)}つ選んでください（あと{requiredSelect(currentQuestion) - draft.length}つ）
          </p>
        )}
      </div>

      <div
        className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 p-4 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
      >
        <button
          onClick={submitAnswer}
          disabled={!canProceed || submitting}
          className="min-h-12 w-full rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white hover:bg-indigo-700 transition-colors disabled:opacity-40 sm:w-auto"
        >
          {submitting ? "送信中..." : "解答する"}
        </button>
      </div>
      {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}

function ProgressBar({ answered, total }: { answered: number; total: number }) {
  const pct = total > 0 ? Math.round((100 * answered) / total) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-sm text-stone-500">
        <span>
          {answered} / {total} 問
        </span>
        <span className="text-xs text-stone-400">全{total}科目を1問ずつ横断演習</span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-stone-200">
        <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
