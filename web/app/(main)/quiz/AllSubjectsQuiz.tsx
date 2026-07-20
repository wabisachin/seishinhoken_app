"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Question } from "@/lib/types";
import { getStoredProfile, profileScopedKey } from "@/lib/profile";
import ExplanationList from "./ExplanationList";
import { scrollToTop } from "./scrollToTop";

const SET_SIZE = 3;
const STORAGE_KEY = "quiz_session_allsubjects_v1";
// 1科目ぶん(1問)を取得するための、1問あたりの生成リトライ上限
// （科目別演習と同じ /api/quiz/next を使っており、却下が続く場合の保険も同じ考え方）
const MAX_NEXT_ATTEMPTS = 15;

type Answer = { selected: number[]; isCorrect: boolean };
type Persisted = {
  subjectOrder: string[];
  questions: Question[];
  answers: Record<number, Answer>;
  setIndex: number;
  // このセットを解答済みで解説を表示中か、まだ解答前か。resume()でどちらの画面に
  // 戻すかを決めるために使う（無いと常に「answering」に戻ってしまい、解説を見ていた
  // セットの解答状況とちぐはぐになる）
  phase: "answering" | "explaining";
  savedAt: number;
};

function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(profileScopedKey(STORAGE_KEY));
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}
function savePersisted(p: Persisted) {
  localStorage.setItem(profileScopedKey(STORAGE_KEY), JSON.stringify(p));
}
function clearPersisted() {
  localStorage.removeItem(profileScopedKey(STORAGE_KEY));
}

async function requestNextQuestion(
  subject: string,
  excludeIds: number[],
): Promise<{ question: Question | null; exhausted: boolean }> {
  const res = await fetch("/api/quiz/next", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, excludeIds, profile: getStoredProfile() ?? "self" }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return { question: (d.question as Question | null) ?? null, exhausted: !!d.exhausted };
}

/** 全科目演習も科目別演習と全く同じロジック（questionSupply.ts の getOrGenerateNext）で1問を取得する。 */
async function fetchOneQuestion(subject: string, onAttempt: ((n: number) => void) | null): Promise<Question | null> {
  for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS; attempt++) {
    const { question, exhausted } = await requestNextQuestion(subject, []);
    if (question) return question;
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

async function fetchSubjectOrder(): Promise<string[]> {
  const res = await fetch("/api/subjects");
  const d = await res.json();
  const subjects = (d.subjects ?? []) as { subject: string; kind: string | null; taxonomy_items: number }[];
  // 毎回同じ（五十音順の）並びで出題すると、後半の科目ばかり時間切れ・後回しになりがちで
  // 単調にもなるため、演習を始めるたびにシャッフルして出題順を変える
  return shuffleArray(subjects.filter((s) => s.taxonomy_items > 0).map((s) => s.subject));
}

type Phase = "checking" | "resume-prompt" | "loading" | "generating" | "answering" | "explaining" | "done" | "empty";

/**
 * 全18科目を1問ずつ、3問(3科目)を1セットとして出題する。1セット解き終わるたびに
 * その場でセット内の解答・解説を表示し、次のセットへ進む。全分野を横断して満遍なく
 * 触れることが目的のため、科目別演習のような正答率・結果レポートは持たない
 * （「未知の問題への対応力」の計測は実戦模試の役割。詳細はweb/app/api/stats/route.ts参照）。
 */
export default function AllSubjectsQuiz() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [subjectOrder, setSubjectOrder] = useState<string[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [setIndex, setSetIndex] = useState(0);
  const [draft, setDraft] = useState<Record<number, number[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<Persisted | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generatingAttempt, setGeneratingAttempt] = useState(0);
  // 1画面に複数問(1セットぶん)を表示するため、キーは`${questionId}-${citationIndex}`にする
  // 科目ごとに1回だけ取得を開始し、結果(または進行中のPromise)をキャッシュする。
  // 演習が始まったらバックグラウンドのランナーが最後の科目まで順番に生成を進め続けるため、
  // ユーザーが今のセットを解いている間に何セットも先まで用意が進む。
  const oneCacheRef = useRef<Map<string, Promise<Question | null>>>(new Map());
  const runnerActiveRef = useRef(false);
  const cancelledRef = useRef(false);

  function ensureOneStarted(subject: string, onAttempt: ((n: number) => void) | null = null): Promise<Question | null> {
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
        // 失敗はここでは無視する。実際にそのセットへ進む時にforeground側が再試行・エラー表示する
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

  // セットの切り替わり（解答して解説を表示する／次のセットへ進む）のたびに、必ず
  // ページ先頭から読み始められるようにする。個々のsubmitSet()/nextSet()呼び出し側で
  // scrollToTop()を呼び忘れる経路が生まれないよう、表示中のphase・セット番号の変化
  // そのものをトリガーにする一元的な仕組みにしている（web/app/(main)/quiz/page.tsxと同じ考え方）。
  useEffect(() => {
    if (phase === "answering" || phase === "explaining") scrollToTop();
  }, [phase, setIndex]);

  useEffect(() => {
    const persisted = loadPersisted();
    // 「読み込み済みの問題数」ではなく「全18問」を基準にする。読み込み済み分を
    // 解答し終えた直後（explaining画面）は読み込み済み数=解答数になるが、全体は
    // まだ終わっていないため、これをunfinished=falseと誤判定してリロード時に
    // startFresh()で最初からやり直しになってしまっていた
    const unfinished = persisted && Object.keys(persisted.answers).length < persisted.subjectOrder.length;
    if (unfinished) {
      setPendingResume(persisted);
      setPhase("resume-prompt");
    } else {
      void startFresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startFresh() {
    clearPersisted();
    setPhase("loading");
    setError(null);
    setGeneratingAttempt(0);
    try {
      const order = await fetchSubjectOrder();
      if (order.length === 0) {
        setError("出題できる科目がありません。");
        setPhase("empty");
        return;
      }
      setSubjectOrder(order);
      const firstSet: Question[] = [];
      for (let i = 0; i < Math.min(SET_SIZE, order.length); i++) {
        const q = await ensureOneStarted(order[i], (n) => {
          setPhase("loading");
          setGeneratingAttempt(n);
        });
        if (q) firstSet.push(q);
      }
      if (firstSet.length === 0) {
        setError("出題できる問題がまだありません。科目別演習で問題を生成してから試してください。");
        setPhase("empty");
        return;
      }
      setQuestions(firstSet);
      setAnswers({});
      setSetIndex(0);
      setDraft({});
      savePersisted({ subjectOrder: order, questions: firstSet, answers: {}, setIndex: 0, phase: "answering", savedAt: Date.now() });
      setPhase("answering");
      void runBackgroundRunner(order, SET_SIZE);
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
    setSetIndex(pendingResume.setIndex);
    setDraft({});
    setPhase(pendingResume.phase ?? "answering");
    void runBackgroundRunner(pendingResume.subjectOrder, pendingResume.questions.length);
  }

  // 「新しく始める」ではなく、途中状態を消してダッシュボードに戻るだけにする。
  // ここで新しい演習を自動的に始めてしまうと、演習自体をやめたいユーザーにも
  // 何かを新しく始めることを強いてしまうため
  function discardAndDashboard() {
    clearPersisted();
    setPendingResume(null);
    router.push("/");
  }

  function toggle(q: Question, n: number) {
    setDraft((prev) => {
      const cur = prev[q.id] ?? [];
      const maxSelect = q.question_type === "multi" ? 2 : 1;
      let next: number[];
      if (cur.includes(n)) next = cur.filter((x) => x !== n);
      else if (maxSelect === 1) next = [n];
      else next = cur.length < maxSelect ? [...cur, n] : cur;
      return { ...prev, [q.id]: next };
    });
  }

  const setQuestions_ = questions.slice(setIndex * SET_SIZE, setIndex * SET_SIZE + SET_SIZE);
  const requiredSelect = (q: Question) => (q.question_type === "multi" ? 2 : 1);
  const canProceed = setQuestions_.length > 0 && setQuestions_.every((q) => (draft[q.id]?.length ?? 0) === requiredSelect(q));
  const totalSets = Math.ceil(subjectOrder.length / SET_SIZE);
  const isLastSet = setIndex + 1 >= totalSets;
  const answeredCount = Object.keys(answers).length;

  async function submitSet() {
    setSubmitting(true);
    try {
      const results = await Promise.all(
        setQuestions_.map(async (q) => {
          const selected = draft[q.id] ?? [];
          const res = await fetch("/api/attempts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question_id: q.id, selected, mode: "mock", profile: getStoredProfile() ?? "self" }),
          });
          const d = await res.json();
          return { id: q.id, selected, isCorrect: !!d.is_correct };
        }),
      );
      const nextAnswers = { ...answers };
      for (const r of results) nextAnswers[r.id] = { selected: r.selected, isCorrect: r.isCorrect };
      setAnswers(nextAnswers);
      savePersisted({ subjectOrder, questions, answers: nextAnswers, setIndex, phase: "explaining", savedAt: Date.now() });
      setPhase("explaining");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function nextSet() {
    if (isLastSet) {
      clearPersisted();
      setPhase("done");
      return;
    }
    setError(null);
    setPhase("loading");
    setGeneratingAttempt(0);
    try {
      const nextIndex = setIndex + 1;
      const nextSubjects = subjectOrder.slice(nextIndex * SET_SIZE, nextIndex * SET_SIZE + SET_SIZE);
      const nextSetQuestions: Question[] = [];
      for (const subject of nextSubjects) {
        // バックグラウンドランナーが既に用意できていれば即座に返る。まだなら
        // （ユーザーが解答が早く、ランナーがまだそこまで追いついていない場合）ここで待つ
        const q = await ensureOneStarted(subject, (n) => {
          setPhase("generating");
          setGeneratingAttempt(n);
        });
        if (q) nextSetQuestions.push(q);
      }
      const nextQuestions = [...questions, ...nextSetQuestions];
      setQuestions(nextQuestions);
      setSetIndex(nextIndex);
      setDraft({});
      savePersisted({ subjectOrder, questions: nextQuestions, answers, setIndex: nextIndex, phase: "answering", savedAt: Date.now() });
      setPhase("answering");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("explaining");
    }
  }

  if (phase === "checking") return null;

  if (phase === "resume-prompt" && pendingResume) {
    const done = Object.keys(pendingResume.answers).length;
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">全科目演習</h1>
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
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">お疲れさまでした</h1>
        <div className="rounded-2xl bg-white p-6 text-center shadow-warm">
          <p className="text-stone-700">全{subjectOrder.length}問、すべて解答しました。</p>
          <p className="mt-1 text-sm text-stone-500">
            間違えた問題は自動的に復習モードに追加されています。詳しい対応力の計測は実戦模試をご利用ください。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          <button
            onClick={() => void startFresh()}
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

  // --- explaining: 解いたセット(3問)の解答・解説をまとめて表示 ---
  if (phase === "explaining") {
    return (
      <div className="space-y-4 pb-24 sm:pb-0">
        <h1 className="text-lg font-bold">全科目演習</h1>
        <ProgressBar answered={answeredCount} total={subjectOrder.length} />
        <div className="space-y-4">
          {setQuestions_.map((q) => {
            const a = answers[q.id];
            if (!a) return null;
            return (
              <div key={q.id} className="rounded-2xl bg-white p-4 shadow-warm sm:p-5">
                <div className="mb-2 flex items-center gap-2 text-xs text-stone-400">
                  <span className="rounded bg-stone-200 px-2 py-0.5">{q.subject}</span>
                </div>
                <div className="mb-2 flex items-start gap-2">
                  <span className={`shrink-0 font-bold ${a.isCorrect ? "text-green-600" : "text-red-600"}`}>
                    {a.isCorrect ? "○" : "×"}
                  </span>
                  <div>
                    {q.case_text && (
                      <p className="mb-1 rounded bg-stone-50 p-2 text-sm leading-relaxed">
                        <span className="mr-1 font-bold">〔事例〕</span>
                        {q.case_text}
                      </p>
                    )}
                    <p className="text-base font-medium leading-relaxed">{q.stem}</p>
                  </div>
                </div>
                <ol className="mt-3 space-y-2">
                  {q.options.map((opt, oi) => {
                    const n = oi + 1;
                    const isAnswer = q.correct.includes(n);
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
                  questionId={q.id}
                  explanations={q.explanations}
                  correct={q.correct}
                  citations={q.citations}
                  keyPoints={q.key_points}
                  variant="inline"
                />
              </div>
            );
          })}
        </div>
        <div
          className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 p-4 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
        >
          <button
            onClick={nextSet}
            className="min-h-12 w-full rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-700 sm:w-auto"
          >
            {isLastSet ? "終了する" : "次のセットへ"}
          </button>
        </div>
        {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  // --- answering: 3問(3科目)まとめて表示、解答後にまとめて解説を表示 ---
  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      <h1 className="text-lg font-bold">全科目演習</h1>
      <ProgressBar answered={answeredCount} total={subjectOrder.length} />

      {setQuestions_.map((q) => {
        const sel = draft[q.id] ?? [];
        return (
          <div key={q.id} className="rounded-2xl bg-white p-4 shadow-warm sm:p-5">
            <div className="mb-2 flex items-center gap-2 text-xs text-stone-400">
              <span className="rounded bg-stone-200 px-2 py-0.5">{q.subject}</span>
              <span>{q.question_type === "multi" ? "2つ選択" : "1つ選択"}</span>
            </div>
            {q.case_text && (
              <div className="mb-3 rounded bg-stone-50 p-3 text-sm leading-relaxed">
                <span className="mr-1 font-bold">〔事例〕</span>
                {q.case_text}
              </div>
            )}
            <p className="text-base font-medium leading-relaxed">{q.stem}</p>
            <div className="mt-3 space-y-2">
              {q.options.map((opt, i) => {
                const n = i + 1;
                const chosen = sel.includes(n);
                return (
                  <button
                    key={n}
                    onClick={() => toggle(q, n)}
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
            {sel.length > 0 && sel.length < requiredSelect(q) && (
              <p className="mt-2 text-sm font-medium text-amber-700">
                この問題は{requiredSelect(q)}つ選んでください（あと{requiredSelect(q) - sel.length}つ）
              </p>
            )}
          </div>
        );
      })}

      <div
        className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 p-4 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
      >
        <button
          onClick={submitSet}
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
