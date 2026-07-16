"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Question } from "@/lib/types";

const PAGE_SIZE = 3;
const COUNT = 12;
const STORAGE_KEY = "quiz_session_mock_v1";

type Answer = { selected: number[]; isCorrect: boolean };
type Persisted = {
  questions: Question[];
  answers: Record<number, Answer>;
  page: number;
  savedAt: number;
};

function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}
function savePersisted(p: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}
function clearPersisted() {
  localStorage.removeItem(STORAGE_KEY);
}

type Phase = "checking" | "resume-prompt" | "loading" | "answering" | "finished" | "empty";

export default function MockQuiz() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Record<number, number[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<Persisted | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const persisted = loadPersisted();
    const unfinished = persisted && Object.keys(persisted.answers).length < persisted.questions.length;
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
    const res = await fetch(`/api/quiz?mode=mock&count=${COUNT}`);
    const d = await res.json();
    if (d.error || !d.questions || d.questions.length === 0) {
      setError(d.error ?? "問題プールが空です。分野別演習で問題を生成してから試してください。");
      setPhase("empty");
      return;
    }
    setQuestions(d.questions);
    setAnswers({});
    setPage(0);
    setDraft({});
    savePersisted({ questions: d.questions, answers: {}, page: 0, savedAt: Date.now() });
    setPhase("answering");
  }

  function resume() {
    if (!pendingResume) return;
    setQuestions(pendingResume.questions);
    setAnswers(pendingResume.answers);
    setPage(pendingResume.page);
    setDraft({});
    setPhase("answering");
  }

  function discardAndStart() {
    setPendingResume(null);
    void startFresh();
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

  const pageQuestions = questions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const canProceed = pageQuestions.length > 0 && pageQuestions.every((q) => (draft[q.id]?.length ?? 0) > 0);
  const isLastPage = (page + 1) * PAGE_SIZE >= questions.length;

  async function submitPage() {
    setSubmitting(true);
    try {
      const results = await Promise.all(
        pageQuestions.map(async (q) => {
          const selected = draft[q.id] ?? [];
          const res = await fetch("/api/attempts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question_id: q.id, selected, mode: "mock" }),
          });
          const d = await res.json();
          return { id: q.id, selected, isCorrect: !!d.is_correct };
        }),
      );
      const nextAnswers = { ...answers };
      for (const r of results) nextAnswers[r.id] = { selected: r.selected, isCorrect: r.isCorrect };
      setAnswers(nextAnswers);

      if (isLastPage) {
        clearPersisted();
        setPhase("finished");
      } else {
        const nextPage = page + 1;
        setPage(nextPage);
        setDraft({});
        savePersisted({ questions, answers: nextAnswers, page: nextPage, savedAt: Date.now() });
        setPhase("answering");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "checking") return null;

  if (phase === "resume-prompt" && pendingResume) {
    const done = Object.keys(pendingResume.answers).length;
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">全分野ミニ模試</h1>
        <div className="rounded-xl bg-amber-50 p-5 shadow">
          <p className="text-sm text-amber-800">
            前回途中だった模試があります（{done} / {pendingResume.questions.length} 問まで解答済み）。続きから再開しますか？
          </p>
          <div className="mt-3 flex gap-3">
            <button onClick={resume} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700">
              続きから再開する
            </button>
            <button onClick={discardAndStart} className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600">
              新しく始める
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "loading") return <p>出題を準備中...</p>;

  if (phase === "empty") {
    return (
      <div className="space-y-4">
        <p className="rounded bg-amber-100 p-3 text-sm text-amber-800">{error}</p>
        <Link href="/" className="inline-block rounded bg-indigo-600 px-5 py-2 text-white">
          ダッシュボードへ
        </Link>
      </div>
    );
  }

  if (phase === "finished") {
    const bySubject = new Map<string, { correct: number; total: number }>();
    for (const q of questions) {
      const a = answers[q.id];
      if (!a) continue;
      const s = bySubject.get(q.subject) ?? { correct: 0, total: 0 };
      s.total++;
      if (a.isCorrect) s.correct++;
      bySubject.set(q.subject, s);
    }
    const rows = [...bySubject.entries()]
      .map(([subject, s]) => ({ subject, ...s, accuracy: Math.round((100 * s.correct) / Math.max(s.total, 1)) }))
      .sort((a, b) => a.accuracy - b.accuracy);
    const overallCorrect = rows.reduce((sum, r) => sum + r.correct, 0);
    const overallTotal = rows.reduce((sum, r) => sum + r.total, 0);

    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">模試結果</h1>
        <div className="rounded-xl bg-white p-6 text-center shadow">
          <p className="text-4xl font-bold text-indigo-700">
            {overallCorrect} / {overallTotal}
          </p>
          <p className="mt-1 text-slate-600">
            総合正答率 {Math.round((100 * overallCorrect) / Math.max(overallTotal, 1))}%
          </p>
        </div>

        <div className="overflow-hidden rounded-xl bg-white shadow">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left">
              <tr>
                <th className="px-4 py-2">科目</th>
                <th className="px-3 py-2 text-right">正解</th>
                <th className="px-3 py-2 text-right">出題</th>
                <th className="px-3 py-2 text-right">得点率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.subject} className="border-t border-slate-100">
                  <td className="px-4 py-2">{r.subject}</td>
                  <td className="px-3 py-2 text-right">{r.correct}</td>
                  <td className="px-3 py-2 text-right">{r.total}</td>
                  <td className={`px-3 py-2 text-right font-medium ${r.accuracy >= 60 ? "text-green-600" : "text-red-600"}`}>
                    {r.accuracy}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-2">
          {questions.map((q, i) => {
            const a = answers[q.id];
            if (!a) return null;
            return (
              <div key={q.id} className="flex items-center gap-3 rounded-lg bg-white p-3 text-sm shadow-sm">
                <span className={a.isCorrect ? "text-green-600" : "text-red-600"}>{a.isCorrect ? "○" : "×"}</span>
                <span className="text-xs text-slate-400">
                  {i + 1}. {q.subject}
                </span>
                <span className="line-clamp-1">{q.stem}</span>
              </div>
            );
          })}
        </div>

        <div className="flex gap-3">
          <button onClick={() => void startFresh()} className="rounded bg-indigo-600 px-5 py-2 text-white">
            もう一度
          </button>
          <Link href="/stats" className="rounded border border-indigo-600 px-5 py-2 text-indigo-700">
            成績を見る
          </Link>
        </div>
      </div>
    );
  }

  // --- answering: 3問まとめて表示、即時フィードバック無し ---
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          {Math.min(page * PAGE_SIZE + 1, questions.length)}〜{Math.min((page + 1) * PAGE_SIZE, questions.length)} /{" "}
          {questions.length} 問目
        </span>
        <span>結果はまとめて最後に表示されます</span>
      </div>

      {pageQuestions.map((q) => {
        const sel = draft[q.id] ?? [];
        return (
          <div key={q.id} className="rounded-xl bg-white p-5 shadow">
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
              <span className="rounded bg-slate-200 px-2 py-0.5">{q.subject}</span>
              <span>{q.question_type === "multi" ? "2つ選択" : "1つ選択"}</span>
            </div>
            {q.case_text && (
              <div className="mb-3 rounded bg-slate-50 p-3 text-sm leading-relaxed">
                <span className="mr-1 font-bold">〔事例〕</span>
                {q.case_text}
              </div>
            )}
            <p className="font-medium leading-relaxed">{q.stem}</p>
            <div className="mt-3 space-y-2">
              {q.options.map((opt, i) => {
                const n = i + 1;
                const chosen = sel.includes(n);
                return (
                  <button
                    key={n}
                    onClick={() => toggle(q, n)}
                    className={`block w-full rounded-lg border p-3 text-left text-sm ${
                      chosen ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <span className="mr-2 font-bold">{n}</span>
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <button
        onClick={submitPage}
        disabled={!canProceed || submitting}
        className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700 disabled:opacity-40"
      >
        {submitting ? "送信中..." : isLastPage ? "結果を見る" : "次の3問へ"}
      </button>
      {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
