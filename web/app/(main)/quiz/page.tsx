"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Mode, Question } from "@/lib/types";
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
  const [phase, setPhase] = useState<Phase>(mode === "subject" ? "resume-prompt" : "setup");
  const [subjects, setSubjects] = useState<{ subject: string; taxonomy_items: number; kind: string | null }[]>([]);
  const [subject, setSubject] = useState("");
  const [count, setCount] = useState(10);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [records, setRecords] = useState<AnswerRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<PersistedSubjectSession | null>(null);
  const cancelledRef = useRef(false);
  const prefetchedForIndexRef = useRef<number | null>(null);

  useEffect(() => {
    if (mode === "subject") {
      fetch("/api/subjects")
        .then((r) => r.json())
        .then((d) => setSubjects((d.subjects ?? []).filter((s: { taxonomy_items: number }) => s.taxonomy_items > 0)));
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
    setQuestions(pendingResume.questions);
    setIndex(pendingResume.index);
    setRecords(restoredRecords);
    const answeredCurrent = restoredRecords.length > pendingResume.index;
    setSelected(answeredCurrent ? restoredRecords[restoredRecords.length - 1].selected : []);
    setPendingResume(null);
    setPhase(answeredCurrent ? "explaining" : "answering");
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
      let announced = false;
      for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS && !cancelledRef.current; attempt++) {
        const { question, exhausted } = await requestNextQuestion(subject, excludeIds);
        if (question) return question;
        if (exhausted) {
          throw new Error("この科目はこれ以上出題できる問題がありません（上限に達しました）。");
        }
        if (!announced) {
          setPhase("generating");
          announced = true;
        }
      }
      throw new Error("問題の生成に時間がかかりすぎています。時間をおいて再度お試しください。");
    },
    [subject],
  );

  // 現在の問題を解いている/解説を見ている間に、裏で次の1問の用意を進めておく
  // （既に生成済みならこの呼び出しは即座に既存プールから返るだけ。無ければここで
  // 生成が始まるので、ユーザーが次へ進む頃には出来上がっている可能性が高くなる）。
  useEffect(() => {
    if (mode !== "subject" || !subject) return;
    if (phase !== "answering" && phase !== "explaining") return;
    if (records.length >= count) return;
    if (prefetchedForIndexRef.current === index) return;
    prefetchedForIndexRef.current = index;
    const excludeIds = questions.map((qq) => qq.id);
    requestNextQuestion(subject, excludeIds).catch(() => {});
  }, [mode, subject, phase, index, questions, count, records.length]);

  const start = useCallback(async () => {
    setPhase("loading");
    setError(null);
    setRecords([]);
    setSelected([]);

    if (mode === "subject") {
      try {
        const first = await waitForNextSubjectQuestion([]);
        setQuestions([first]);
        setIndex(0);
        setPhase("answering");
        saveSubjectSession({ subject, count, questions: [first], records: [], index: 0, savedAt: Date.now() });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("setup");
      }
      return;
    }

    const qs = new URLSearchParams({ mode, count: String(count) });
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

  // 復習モードは即開始できる
  useEffect(() => {
    if (mode === "review" && phase === "setup" && questions.length === 0 && !error) {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
      body: JSON.stringify({ question_id: q.id, selected, mode }),
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
      try {
        const excludeIds = questions.map((qq) => qq.id);
        const nextQ = await waitForNextSubjectQuestion(excludeIds);
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
        <div className="rounded-xl bg-amber-50 p-5 shadow">
          <p className="text-sm text-amber-800">
            前回途中だった演習があります（{pendingResume.subject}: {pendingResume.records.length} / {pendingResume.count} 問まで解答済み）。続きから再開しますか？
          </p>
          <div className="mt-3 flex gap-3">
            <button onClick={resumeSession} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700">
              続きから再開する
            </button>
            <button onClick={discardSession} className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600">
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
          <div className="rounded-xl bg-white p-5 shadow">
            <label className="block text-sm font-medium">科目</label>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 p-2"
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
              min={1}
              max={50}
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value || "10", 10))}
              className="mt-1 w-24 rounded border border-slate-300 p-2"
            />
            <div className="mt-4">
              <button
                onClick={start}
                disabled={!subject}
                className="rounded bg-indigo-600 px-5 py-2 text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                開始
              </button>
            </div>
          </div>
        )}
        {mode !== "subject" && !error && <p className="text-sm text-slate-600">読み込み中...</p>}
        {mode !== "subject" && error && (
          <Link href="/" className="inline-block rounded bg-indigo-600 px-5 py-2 text-white">
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
        <p className="rounded bg-indigo-50 p-3 text-sm text-indigo-800">
          次の問題を生成中です。しばらくお待ちください...
        </p>
      </div>
    );
  }

  if (phase === "stalled") {
    return (
      <div className="space-y-3">
        <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error ?? "問題を生成できませんでした。"}</p>
        <button onClick={retryAfterStall} className="rounded bg-indigo-600 px-5 py-2 text-white hover:bg-indigo-700">
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
        <div className="rounded-xl bg-white p-6 text-center shadow">
          <p className="text-4xl font-bold text-indigo-700">
            {correct} / {records.length}
          </p>
          <p className="mt-1 text-slate-600">正答率 {Math.round((100 * correct) / Math.max(records.length, 1))}%</p>
        </div>
        <div className="space-y-2">
          {records.map((r, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg bg-white p-3 text-sm shadow-sm">
              <span className={r.isCorrect ? "text-green-600" : "text-red-600"}>{r.isCorrect ? "○" : "×"}</span>
              <span className="text-xs text-slate-400">{r.question.subject}</span>
              <span className="line-clamp-1">{r.question.stem}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setPhase("setup");
              setQuestions([]);
              setError(null);
            }}
            className="rounded bg-indigo-600 px-5 py-2 text-white"
          >
            もう一度
          </button>
          <Link href="/stats" className="rounded border border-indigo-600 px-5 py-2 text-indigo-700">
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
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          {index + 1} / {mode === "subject" ? count : questions.length} 問目
          <span className="ml-3 rounded bg-slate-200 px-2 py-0.5 text-xs">{q.subject}</span>
        </span>
        <span>{q.question_type === "multi" ? "2つ選択" : "1つ選択"}</span>
      </div>

      <div className="rounded-xl bg-white p-5 shadow">
        {q.case_text && (
          <div className="mb-4 rounded bg-slate-50 p-3 text-sm leading-relaxed">
            <span className="mr-1 font-bold">〔事例〕</span>
            {q.case_text}
          </div>
        )}
        <p className="font-medium leading-relaxed">{q.stem}</p>
        <div className="mt-4 space-y-2">
          {q.options.map((opt, i) => {
            const n = i + 1;
            const chosen = phase === "explaining" ? record.selected.includes(n) : selected.includes(n);
            const isAnswer = q.correct.includes(n);
            let style = "border-slate-200 bg-white hover:bg-slate-50";
            if (phase === "explaining") {
              if (isAnswer) style = "border-green-500 bg-green-50";
              else if (chosen) style = "border-red-400 bg-red-50";
              else style = "border-slate-200 bg-white opacity-70";
            } else if (chosen) {
              style = "border-indigo-500 bg-indigo-50";
            }
            return (
              <button
                key={n}
                disabled={phase === "explaining"}
                onClick={() => toggle(n)}
                className={`block w-full rounded-lg border p-3 text-left text-sm ${style}`}
              >
                <span className="mr-2 font-bold">{n}</span>
                {opt}
                {phase === "explaining" && isAnswer && <span className="ml-2 text-green-600">✓ 正答</span>}
              </button>
            );
          })}
        </div>
        {phase === "answering" && (
          <button
            onClick={submit}
            disabled={selected.length === 0}
            className="mt-4 rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            解答する
          </button>
        )}
      </div>

      {phase === "explaining" && (
        <div className="space-y-4">
          <div
            className={`rounded-xl p-4 text-center text-lg font-bold ${
              record.isCorrect ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            }`}
          >
            {record.isCorrect ? "正解！" : `不正解（正答: ${q.correct.join("、")}）`}
          </div>

          <div className="rounded-xl bg-white p-5 shadow">
            <h3 className="mb-3 font-bold text-indigo-700">選択肢ごとの解説</h3>
            <ol className="space-y-3">
              {q.explanations.map((ex, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span
                    className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      q.correct.includes(i + 1) ? "bg-green-600 text-white" : "bg-slate-300 text-slate-700"
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
            <div className="rounded-xl bg-amber-50 p-5 shadow">
              <h3 className="mb-2 font-bold text-amber-800">押さえておくべきポイント</h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{q.key_points}</p>
            </div>
          )}

          {q.citations && q.citations.length > 0 && (
            <div className="rounded-xl bg-white p-5 shadow">
              <h3 className="mb-2 font-bold text-slate-700">教科書の根拠</h3>
              {q.citations.map((c, i) => (
                <blockquote key={i} className="mb-3 border-l-4 border-indigo-200 pl-3 text-sm text-slate-600">
                  <p className="whitespace-pre-wrap leading-relaxed">{c.excerpt}</p>
                  <footer className="mt-1 text-xs text-slate-400">
                    {c.book} p.{c.page_start}
                    {c.page_end !== c.page_start ? `–${c.page_end}` : ""}
                  </footer>
                </blockquote>
              ))}
            </div>
          )}

          <button onClick={next} className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700">
            {(mode === "subject" ? records.length >= count : index + 1 >= questions.length) ? "結果を見る" : "次の問題へ"}
          </button>
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
