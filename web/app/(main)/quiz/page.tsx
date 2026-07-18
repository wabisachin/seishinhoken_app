"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Mode, Question } from "@/lib/types";
import { dedupeCitations } from "@/lib/citations";
import { getStoredProfile } from "@/lib/profile";
import MockQuiz from "./MockQuiz";

type Phase =
  | "resume-prompt"
  | "setup"
  | "loading"
  | "answering"
  | "explaining"
  | "generating"
  | "stalled"
  | "finished";

type AnswerRecord = {
  question: Question;
  selected: number[];
  isCorrect: boolean;
};

// 分野別モード（mode=subject）: 次の1問取得は毎回サーバー側で高々1回だけ生成を試みる
// リクエスト駆動方式（lib/questionSupply.ts）。却下が続く場合のみ複数回叩く必要があるため、
// UXの保険として呼び出し回数の上限だけクライアント側にも置く（コストの上限はサーバー側の行数判定）。
const MAX_NEXT_ATTEMPTS = 15;

// 1セッションで一気に要求できる出題数の上限。ここが無いと「一度に100問」のような
// リクエストで生成が延々と連発されてしまうため、UI側でも明示的に絞っておく。
const DEFAULT_SESSION_COUNT = 5;
const MAX_SESSION_COUNT = 10;

// 復習モードは新規生成を一切行わない（既存問題の読み出しのみ）ため、
// 分野別演習のコスト上限用カウント(count状態)とは無関係に、独自の出題数を使う。
const REVIEW_COUNT = 10;

// 分野別演習の途中経過をlocalStorageに保存し、リロード/離脱後に再開できるようにする
const SUBJECT_SESSION_KEY = "quiz_session_subject_v1";

type PersistedSubjectSession = {
  subject: string;
  count: number;
  questions: Question[];
  records: { questionId: number; selected: number[]; isCorrect: boolean }[];
  index: number;
  savedAt: number;
};

function loadSubjectSession(): PersistedSubjectSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SUBJECT_SESSION_KEY);
    return raw ? (JSON.parse(raw) as PersistedSubjectSession) : null;
  } catch {
    return null;
  }
}
function saveSubjectSession(s: PersistedSubjectSession) {
  localStorage.setItem(SUBJECT_SESSION_KEY, JSON.stringify(s));
}
function clearSubjectSession() {
  localStorage.removeItem(SUBJECT_SESSION_KEY);
}

async function requestNextQuestion(
  subject: string,
  excludeIds: number[],
): Promise<{ question: Question | null; exhausted: boolean }> {
  const res = await fetch("/api/quiz/next", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, excludeIds }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return { question: (d.question as Question | null) ?? null, exhausted: !!d.exhausted };
}

function QuizInner({ mode }: { mode: Mode }) {
  // 分野別モードは「前回セッションがあるか」をマウント後のeffectで判定してから
  // resume-promptかsetupに遷移する。判定が終わるまでの初期値は必ず何か表示される
  // phaseにしておく（resume-promptはpendingResumeが無いと何も描画しないため、
  // 初期値に使うとハイドレーション完了までの一瞬〜稀に長時間、画面が真っ暗に見える）。
  const [phase, setPhase] = useState<Phase>(mode === "subject" ? "loading" : "setup");
  const [subjects, setSubjects] = useState<{ subject: string; taxonomy_items: number; kind: string | null }[]>([]);
  const [subject, setSubject] = useState("");
  const [count, setCount] = useState(DEFAULT_SESSION_COUNT);
  const [countInput, setCountInput] = useState(String(DEFAULT_SESSION_COUNT));
  const [countError, setCountError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [records, setRecords] = useState<AnswerRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<PersistedSubjectSession | null>(null);
  const [generatingAttempt, setGeneratingAttempt] = useState(0);
  const [expandedCitation, setExpandedCitation] = useState<number | null>(null);
  const [reviewSubjects, setReviewSubjects] = useState<
    { subject: string; correct: number; total: number; wrongCount: number; accuracy: number }[]
  >([]);
  const [reviewTotalWrong, setReviewTotalWrong] = useState(0);
  const [reviewSummaryLoading, setReviewSummaryLoading] = useState(true);
  const cancelledRef = useRef(false);
  // 分野別モード: セッション開始直後から、残り問題を裏で連続的に先読みしておく
  // （1問先読みだけだと、読むのが速いユーザーには追いつけないため、模試の
  // バックグラウンドランナーと同じ考え方でセッション分すべて先読みを進める）。
  // 各問題は前の問題のIDをexcludeIdsに積み上げる必要があり並列化できないため、
  // 1問ずつ順番に取得しながらMapに結果を積んでいく。
  const prefetchQueueRef = useRef<Map<number, Promise<{ question: Question | null; exhausted: boolean }>>>(new Map());
  const prefetchChainStartedRef = useRef(false);

  useEffect(() => {
    if (mode === "subject") {
      fetch("/api/subjects")
        .then((r) => r.json())
        .then((d) => setSubjects((d.subjects ?? []).filter((s: { taxonomy_items: number }) => s.taxonomy_items > 0)));
    }
    if (mode === "review") {
      setReviewSummaryLoading(true);
      fetch("/api/quiz/review-summary")
        .then((r) => r.json())
        .then((d) => {
          setReviewSubjects(d.subjects ?? []);
          setReviewTotalWrong(d.totalWrong ?? 0);
        })
        .finally(() => setReviewSummaryLoading(false));
    }
  }, [mode]);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // 分野別モードのみ: 前回途中だったセッションが無いか起動時に確認する
  useEffect(() => {
    if (mode !== "subject") return;
    const persisted = loadSubjectSession();
    if (persisted && persisted.records.length < persisted.count) {
      setPendingResume(persisted);
      setPhase("resume-prompt");
    } else {
      setPhase("setup");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function resumeSession() {
    if (!pendingResume) return;
    const byId = new Map(pendingResume.questions.map((q) => [q.id, q]));
    const restoredRecords: AnswerRecord[] = pendingResume.records
      .map((r) => {
        const question = byId.get(r.questionId);
        return question ? { question, selected: r.selected, isCorrect: r.isCorrect } : null;
      })
      .filter((r): r is AnswerRecord => r !== null);
    setSubject(pendingResume.subject);
    setCount(pendingResume.count);
    setCountInput(String(pendingResume.count));
    setQuestions(pendingResume.questions);
    setIndex(pendingResume.index);
    setRecords(restoredRecords);
    const answeredCurrent = restoredRecords.length > pendingResume.index;
    setSelected(answeredCurrent ? restoredRecords[restoredRecords.length - 1].selected : []);
    setPendingResume(null);
    setPhase(answeredCurrent ? "explaining" : "answering");
    prefetchChainStartedRef.current = false;
    prefetchQueueRef.current.clear();
    void runSubjectPrefetchChain(
      pendingResume.questions.map((q) => q.id),
      pendingResume.count,
      pendingResume.questions.length,
    );
  }

  function discardSession() {
    clearSubjectSession();
    setPendingResume(null);
    setPhase("setup");
  }

  /**
   * 分野別モード: まだ見ていない問題を1問取得する。既存プールに無ければサーバーが
   * その場で高々1回だけ生成を試みて返す（lib/questionSupply.ts）。却下が続く場合は
   * こちらから複数回呼び直す必要があるため、UXの保険として回数の上限を設ける
   * （コストの上限自体はサーバー側がquestionsテーブルの行数で判定済み）。
   */
  const waitForNextSubjectQuestion = useCallback(
    async (excludeIds: number[]) => {
      for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS && !cancelledRef.current; attempt++) {
        const { question, exhausted } = await requestNextQuestion(subject, excludeIds);
        if (question) return question;
        if (exhausted) {
          throw new Error("この科目はこれ以上出題できる問題がありません（上限に達しました）。");
        }
        setPhase("generating");
        setGeneratingAttempt(attempt + 1);
      }
      throw new Error(
        "問題の生成に時間がかかりすぎています。この分野は教科書の記述から出題を作りにくく、生成のやり直しが続いている可能性があります。時間をおいて再度お試しください。",
      );
    },
    [subject],
  );

  // 却下等で取得できなかった場合だけ、フォアグラウンドと同じ回数だけ静かにリトライする
  // （generating表示やgeneratingAttemptは更新しない。ユーザーはまだこのスロットを待っていないため）
  const silentlyFetchOne = useCallback(
    async (excludeIds: number[]) => {
      for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS && !cancelledRef.current; attempt++) {
        const result = await requestNextQuestion(subject, excludeIds).catch(() => ({ question: null, exhausted: false }));
        if (result.question || result.exhausted) return result;
      }
      return { question: null, exhausted: false };
    },
    [subject],
  );

  // セッション開始直後から、残りの問題を裏で連続的に先読みする。1問ずつ順番に
  // （前の問題のIDをexcludeIdsに積み上げる必要があるため並列化できない）取得し、
  // 結果をスロット番号(index)ごとにMapへ積んでおく。next()はここから取り出すだけで済むので、
  // ユーザーが読んでいる間に複数問先まで用意が進む（模試のバックグラウンドランナーと同じ考え方）。
  const runSubjectPrefetchChain = useCallback(
    async (seedExcludeIds: number[], sessionCount: number, startIndex: number) => {
      if (prefetchChainStartedRef.current) return;
      prefetchChainStartedRef.current = true;
      let excludeIds = [...seedExcludeIds];
      for (let idx = startIndex; idx < sessionCount; idx++) {
        if (cancelledRef.current) break;
        const p = silentlyFetchOne(excludeIds);
        prefetchQueueRef.current.set(idx, p);
        const result = await p;
        if (result.question) {
          excludeIds = [...excludeIds, result.question.id];
        } else {
          break; // これ以上の先読みは無駄と判断して打ち切る。フォアグラウンド側が改めて試みる
        }
      }
    },
    [silentlyFetchOne],
  );

  const start = useCallback(async () => {
    setPhase("loading");
    setError(null);
    setRecords([]);
    setSelected([]);

    if (mode === "subject") {
      setGeneratingAttempt(0);
      prefetchChainStartedRef.current = false;
      prefetchQueueRef.current.clear();
      try {
        const first = await waitForNextSubjectQuestion([]);
        setQuestions([first]);
        setIndex(0);
        setPhase("answering");
        saveSubjectSession({ subject, count, questions: [first], records: [], index: 0, savedAt: Date.now() });
        void runSubjectPrefetchChain([first.id], count, 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("setup");
      }
      return;
    }

    const qs = new URLSearchParams({ mode, count: String(mode === "review" ? REVIEW_COUNT : count) });
    if (mode === "review") qs.set("subject", subject || "all");
    const res = await fetch(`/api/quiz?${qs}`);
    const d = await res.json();
    if (d.error) {
      setError(d.error);
      setPhase("setup");
      return;
    }
    if (!d.questions || d.questions.length === 0) {
      setError("復習対象の誤答問題がありません。まず演習してみましょう。");
      setPhase("setup");
      return;
    }
    setQuestions(d.questions);
    setIndex(0);
    setPhase("answering");
  }, [mode, subject, count, waitForNextSubjectQuestion]);

  const q = questions[index];
  const maxSelect = q?.question_type === "multi" ? 2 : 1;

  function toggle(n: number) {
    setSelected((prev) => {
      if (prev.includes(n)) return prev.filter((x) => x !== n);
      if (maxSelect === 1) return [n];
      return prev.length < maxSelect ? [...prev, n] : prev;
    });
  }

  async function submit() {
    if (!q || selected.length === 0) return;
    const res = await fetch("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: q.id, selected, mode, profile: getStoredProfile() ?? "self" }),
    });
    const d = await res.json();
    if (d.error) {
      setError(d.error);
      return;
    }
    const nextRecords = [...records, { question: q, selected, isCorrect: d.is_correct as boolean }];
    setRecords(nextRecords);
    setPhase("explaining");
    if (mode === "subject") {
      saveSubjectSession({
        subject,
        count,
        questions,
        records: nextRecords.map((r) => ({ questionId: r.question.id, selected: r.selected, isCorrect: r.isCorrect })),
        index,
        savedAt: Date.now(),
      });
    }
  }

  async function next() {
    setExpandedCitation(null);
    if (mode === "subject") {
      if (records.length >= count) {
        clearSubjectSession();
        setPhase("finished");
        return;
      }
      if (index + 1 < questions.length) {
        setIndex(index + 1);
        setSelected([]);
        setPhase("answering");
        return;
      }
      setError(null);
      setPhase("loading");
      setGeneratingAttempt(0);
      try {
        const excludeIds = questions.map((qq) => qq.id);
        const nextIndex = index + 1;
        const queued = prefetchQueueRef.current.get(nextIndex);
        prefetchQueueRef.current.delete(nextIndex);
        const prefetchedResult = queued ? await queued : null;
        const nextQ = prefetchedResult?.question ?? (await waitForNextSubjectQuestion(excludeIds));
        const nextQuestions = [...questions, nextQ];
        setQuestions(nextQuestions);
        setIndex(index + 1);
        setSelected([]);
        setPhase("answering");
        saveSubjectSession({
          subject,
          count,
          questions: nextQuestions,
          records: records.map((r) => ({ questionId: r.question.id, selected: r.selected, isCorrect: r.isCorrect })),
          index: index + 1,
          savedAt: Date.now(),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("stalled");
      }
      return;
    }

    if (index + 1 >= questions.length) {
      setPhase("finished");
    } else {
      setIndex(index + 1);
      setSelected([]);
      setPhase("answering");
    }
  }

  function retryAfterStall() {
    setError(null);
    void next();
  }

  // --- 再開バナー ---
  if (phase === "resume-prompt" && pendingResume) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">分野別演習</h1>
        <div className="rounded-2xl bg-amber-50 p-5 shadow-warm">
          <p className="text-sm text-amber-800">
            前回途中だった演習があります（{pendingResume.subject}: {pendingResume.records.length} / {pendingResume.count} 問まで解答済み）。続きから再開しますか？
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-3">
            <button
              onClick={resumeSession}
              className="min-h-12 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              続きから再開する
            </button>
            <button
              onClick={discardSession}
              className="min-h-12 rounded-xl border border-stone-300 px-4 py-3 text-sm text-stone-600 transition-colors hover:bg-stone-100"
            >
              新しく始める
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- セットアップ画面 ---
  if (phase === "setup") {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">{mode === "subject" ? "分野別演習" : "復習モード"}</h1>
        {error && <p className="rounded bg-amber-100 p-3 text-sm text-amber-800">{error}</p>}
        {mode === "subject" && (
          <div className="rounded-2xl bg-white p-5 shadow-warm">
            <label className="block text-sm font-medium">科目</label>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1 min-h-12 w-full rounded-xl border border-stone-300 p-3"
            >
              <option value="">選択してください</option>
              {subjects.map((s) => (
                <option key={s.subject} value={s.subject}>
                  {s.subject}
                </option>
              ))}
            </select>
            <label className="mt-4 block text-sm font-medium">出題数</label>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_SESSION_COUNT}
              value={countInput}
              onChange={(e) => {
                const raw = e.target.value;
                setCountInput(raw);
                if (raw === "") {
                  setCountError(null);
                  return;
                }
                const n = parseInt(raw, 10);
                if (Number.isNaN(n)) {
                  setCountError("数字を入力してください。");
                } else if (n > MAX_SESSION_COUNT) {
                  setCountError(`1セッションあたり最大${MAX_SESSION_COUNT}問までです。それ以上は選択できません。`);
                  setCount(MAX_SESSION_COUNT);
                } else if (n < 1) {
                  setCountError("1問以上を指定してください。");
                } else {
                  setCountError(null);
                  setCount(n);
                }
              }}
              onBlur={() => {
                const n = parseInt(countInput, 10);
                if (countInput === "" || Number.isNaN(n) || n < 1) {
                  setCountInput(String(DEFAULT_SESSION_COUNT));
                  setCount(DEFAULT_SESSION_COUNT);
                } else if (n > MAX_SESSION_COUNT) {
                  setCountInput(String(MAX_SESSION_COUNT));
                  setCount(MAX_SESSION_COUNT);
                }
                setCountError(null);
              }}
              className="mt-1 min-h-12 w-24 rounded-xl border border-stone-300 p-3"
            />
            {countError ? (
              <p className="mt-1 text-xs text-red-600">{countError}</p>
            ) : (
              <p className="mt-1 text-xs text-stone-400">
                一度に生成される問題数を抑えるため、1セッションあたり最大{MAX_SESSION_COUNT}問までです。
              </p>
            )}
            <div className="mt-4">
              <button
                onClick={start}
                disabled={!subject}
                className="min-h-12 w-full rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700 transition-colors disabled:opacity-40 sm:w-auto"
              >
                開始
              </button>
            </div>
          </div>
        )}
        {mode === "review" && !error && (
          <>
            {reviewSummaryLoading ? (
              <p className="text-sm text-stone-600">読み込み中...</p>
            ) : reviewSubjects.length === 0 ? (
              <div className="rounded-2xl bg-white p-5 shadow-warm">
                <p className="text-sm text-stone-600">間違えた問題がまだありません。まず演習してみましょう。</p>
                <Link
                  href="/"
                  className="mt-3 inline-flex min-h-12 items-center rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
                >
                  ダッシュボードへ
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={() => {
                    setSubject("all");
                    void start();
                  }}
                  className="w-full rounded-2xl border-l-4 border-indigo-500 bg-white p-4 text-left shadow-warm transition-all hover:-translate-y-0.5 hover:shadow-warm-lg"
                >
                  <p className="font-bold text-indigo-700">全科目から出題</p>
                  <p className="mt-1 text-sm text-stone-600">間違えた問題 {reviewTotalWrong}問から、間違えた回数が多いものほど出やすいランダム出題</p>
                </button>
                <div>
                  <p className="mb-2 text-sm font-medium text-stone-700">科目ごとに復習する</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {reviewSubjects.map((s) => {
                      // 苦手判定は間違えた問題数の絶対数ではなく正答率で行う
                      // （出題数が多い科目ほど間違えた数も単純に増えるため）
                      const style =
                        s.accuracy < 50
                          ? "border-red-500 bg-red-50"
                          : s.accuracy < 70
                            ? "border-amber-500 bg-amber-50"
                            : "border-stone-300 bg-white";
                      const badgeStyle =
                        s.accuracy < 50
                          ? "bg-red-600 text-white"
                          : s.accuracy < 70
                            ? "bg-amber-500 text-white"
                            : "bg-stone-200 text-stone-700";
                      return (
                        <button
                          key={s.subject}
                          onClick={() => {
                            setSubject(s.subject);
                            void start();
                          }}
                          className={`flex items-center justify-between rounded-xl border-l-4 p-3 text-left shadow-warm-sm transition-all hover:-translate-y-0.5 hover:shadow-warm ${style}`}
                        >
                          <span className="text-sm font-medium text-stone-800">{s.subject}</span>
                          <span className="ml-2 flex shrink-0 flex-col items-end">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${badgeStyle}`}>
                              正答率{s.accuracy}%
                            </span>
                            <span className="mt-1 text-xs text-stone-400">
                              {s.total}問中{s.correct}問正解
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        {mode !== "subject" && mode !== "review" && error && (
          <Link href="/" className="inline-flex min-h-12 items-center rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700">
            ダッシュボードへ
          </Link>
        )}
      </div>
    );
  }

  if (phase === "loading") return <p>出題を準備中...</p>;

  if (phase === "generating") {
    return (
      <div className="space-y-3">
        <p className="rounded-xl bg-indigo-50 p-4 text-sm text-indigo-800">
          次の問題を生成中です。しばらくお待ちください...
          <br />
          <span className="text-xs text-indigo-600">
            1回の生成に20〜60秒ほどかかることがあります（{generatingAttempt} / {MAX_NEXT_ATTEMPTS} 回目）
          </span>
        </p>
      </div>
    );
  }

  if (phase === "stalled") {
    return (
      <div className="space-y-3">
        <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error ?? "問題を生成できませんでした。"}</p>
        <button onClick={retryAfterStall} className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700 transition-colors">
          もう一度試す
        </button>
      </div>
    );
  }

  // --- 結果画面 ---
  if (phase === "finished") {
    const correct = records.filter((r) => r.isCorrect).length;
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">結果</h1>
        <div className="rounded-2xl bg-white p-6 text-center shadow-warm">
          <p className="text-4xl font-bold text-indigo-700">
            {correct} / {records.length}
          </p>
          <p className="mt-1 text-stone-600">正答率 {Math.round((100 * correct) / Math.max(records.length, 1))}%</p>
        </div>
        <div className="space-y-2">
          {records.map((r, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-white p-3 text-sm shadow-warm-sm">
              <span className={r.isCorrect ? "text-green-600" : "text-red-600"}>{r.isCorrect ? "○" : "×"}</span>
              <span className="text-xs text-stone-400">{r.question.subject}</span>
              <span className="line-clamp-1">{r.question.stem}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setQuestions([]);
              setError(null);
              if (mode === "review") {
                // 科目選択をやり直せるよう、選択画面に戻す（成績が変わっている可能性もあるため
                // 苦手科目の集計も再取得する）
                setReviewSummaryLoading(true);
                fetch("/api/quiz/review-summary")
                  .then((r) => r.json())
                  .then((d) => {
                    setReviewSubjects(d.subjects ?? []);
                    setReviewTotalWrong(d.totalWrong ?? 0);
                  })
                  .finally(() => setReviewSummaryLoading(false));
              }
              setPhase("setup");
            }}
            className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
          >
            もう一度
          </button>
          <Link href="/stats" className="inline-flex min-h-12 items-center rounded-xl border border-indigo-600 px-5 py-3 font-medium text-indigo-700 transition-colors hover:bg-indigo-50">
            成績を見る
          </Link>
        </div>
      </div>
    );
  }

  if (!q) return null;
  const record = records[records.length - 1];

  // --- 出題 / 解説 ---
  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      <div className="flex items-center justify-between text-sm text-stone-500">
        <span>
          {index + 1} / {mode === "subject" ? count : questions.length} 問目
          <span className="ml-3 rounded bg-stone-200 px-2 py-0.5 text-xs">{q.subject}</span>
        </span>
        <span>{q.question_type === "multi" ? "2つ選択" : "1つ選択"}</span>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-warm sm:p-5">
        {q.case_text && (
          <div className="mb-4 rounded bg-stone-50 p-3 text-sm leading-relaxed">
            <span className="mr-1 font-bold">〔事例〕</span>
            {q.case_text}
          </div>
        )}
        <p className="text-base font-medium leading-relaxed">{q.stem}</p>
        <div className="mt-4 space-y-2">
          {q.options.map((opt, i) => {
            const n = i + 1;
            const chosen = phase === "explaining" ? record.selected.includes(n) : selected.includes(n);
            const isAnswer = q.correct.includes(n);
            let style = "border-stone-200 bg-white hover:bg-stone-50";
            if (phase === "explaining") {
              if (isAnswer) style = "border-green-500 bg-green-50";
              else if (chosen) style = "border-red-400 bg-red-50";
              else style = "border-stone-200 bg-white opacity-70";
            } else if (chosen) {
              style = "border-indigo-500 bg-indigo-50";
            }
            return (
              <button
                key={n}
                disabled={phase === "explaining"}
                onClick={() => toggle(n)}
                className={`block min-h-12 w-full rounded-xl border p-3.5 text-left text-[15px] leading-snug transition-colors sm:text-sm ${style}`}
              >
                <span className="mr-2 font-bold">{n}</span>
                {opt}
                {phase === "explaining" && isAnswer && <span className="ml-2 text-green-600">✓ 正答</span>}
              </button>
            );
          })}
        </div>
        {phase === "answering" && (
          <div
            className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 p-4 backdrop-blur sm:static sm:mt-4 sm:border-0 sm:bg-transparent sm:p-0"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
          >
            {selected.length > 0 && selected.length < maxSelect && (
              <p className="mb-2 text-sm font-medium text-amber-700">
                この問題は{maxSelect}つ選んでください（あと{maxSelect - selected.length}つ）
              </p>
            )}
            <button
              onClick={submit}
              disabled={selected.length !== maxSelect}
              className="min-h-12 w-full rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white hover:bg-indigo-700 transition-colors disabled:opacity-40 sm:w-auto"
            >
              解答する
            </button>
          </div>
        )}
      </div>

      {phase === "explaining" && (
        <div className="space-y-4">
          <div
            className={`rounded-2xl p-4 text-center text-lg font-bold ${
              record.isCorrect ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            }`}
          >
            {record.isCorrect ? "正解！" : `不正解（正答: ${q.correct.join("、")}）`}
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-warm">
            <h3 className="mb-3 font-bold text-indigo-700">選択肢ごとの解説</h3>
            <ol className="space-y-3">
              {q.explanations.map((ex, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span
                    className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      q.correct.includes(i + 1) ? "bg-green-600 text-white" : "bg-stone-300 text-stone-700"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span>{ex}</span>
                </li>
              ))}
            </ol>
          </div>

          {q.key_points && (
            <div className="rounded-2xl bg-amber-50 p-5 shadow-warm">
              <h3 className="mb-2 font-bold text-amber-800">押さえておくべきポイント</h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{q.key_points}</p>
            </div>
          )}

          {q.citations && q.citations.length > 0 && (
            <div className="rounded-2xl bg-white p-5 shadow-warm">
              <h3 className="mb-2 font-bold text-stone-700">教科書の根拠</h3>
              <ul className="space-y-2">
                {dedupeCitations(q.citations).map((c, i) => {
                  const expanded = expandedCitation === i;
                  return (
                    <li key={i} className="rounded-xl border border-stone-100">
                      <button
                        onClick={() => setExpandedCitation(expanded ? null : i)}
                        className="flex min-h-10 w-full items-center gap-2 p-2 text-left text-sm text-stone-600"
                      >
                        <span className="text-indigo-300">・</span>
                        <span className="flex-1">
                          {c.book} p.{c.page_start}
                          {c.page_end !== c.page_start ? `–${c.page_end}` : ""}
                        </span>
                        <span className="shrink-0 text-xs font-bold text-indigo-500">{expanded ? "－" : "＋"}</span>
                      </button>
                      {expanded && (
                        <p className="whitespace-pre-wrap border-t border-stone-100 p-3 text-sm leading-relaxed text-stone-600">
                          {c.excerpt}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div
            className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 p-4 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
          >
            <button
              onClick={next}
              className="min-h-12 w-full rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-700 sm:w-auto"
            >
              {(mode === "subject" ? records.length >= count : index + 1 >= questions.length) ? "結果を見る" : "次の問題へ"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}

function QuizRouter() {
  const params = useSearchParams();
  const mode = (params.get("mode") ?? "subject") as Mode;
  if (mode === "mock") return <MockQuiz />;
  return <QuizInner mode={mode} />;
}

export default function QuizPage() {
  return (
    <Suspense fallback={<p>読み込み中...</p>}>
      <QuizRouter />
    </Suspense>
  );
}
