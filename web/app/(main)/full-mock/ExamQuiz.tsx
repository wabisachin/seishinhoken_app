"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Question } from "@/lib/types";
import type { ExamPart } from "@/lib/examFormat";

const PART_LABEL: Record<ExamPart, string> = { common: "午前の部（共通科目）", specialized: "午後の部（専門科目）" };

type ExamStatusValue = "not_started" | "in_progress" | "completed";
type ExamState = {
  hasInProgress: boolean;
  examAttemptId?: number;
  commonStatus?: ExamStatusValue;
  specializedStatus?: ExamStatusValue;
  remainingThisMonth: number;
  commonReady: boolean;
  specializedReady: boolean;
  canStartNewRound: boolean;
};
type Answer = { selected: number[]; isCorrect: boolean };
type SubjectScore = { subject: string; correct: number; total: number };
type Verdict = { passed: boolean; overallRate: number; totalCorrect: number; totalQuestions: number; failedGroups: string[] };
type HistoryEntry = { examAttemptId: number; completedAt: string; verdict: Verdict; bySubject: SubjectScore[] };
// /api/exam/questionsはそのexam_attempt内での解答(yourAnswer)を埋め込んで返すため、
// 再開時の進捗（どこまで解答済みか）・残り時間はどちらもサーバー側の記録だけを正として
// 復元する（localStorageには一切頼らない。別端末・ブラウザデータ消去後でも、途中離脱
// した模試を必ず正しい位置・正しい残り時間から再開できるようにするため）
type ExamQuestion = Question & { yourAnswer: Answer | null };

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Phase = "checking" | "select" | "waiting-stock" | "starting" | "answering" | "part-result" | "final-result" | "error";

export default function ExamQuiz() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [state, setState] = useState<ExamState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [examAttemptId, setExamAttemptId] = useState<number | null>(null);
  const [part, setPart] = useState<ExamPart | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [subjectOrder, setSubjectOrder] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [draft, setDraft] = useState<Record<number, number[]>>({});
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);

  const [partResult, setPartResult] = useState<{ bySubject: SubjectScore[]; correct: number; total: number } | null>(null);
  const [finishedPart, setFinishedPart] = useState<ExamPart | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [finalQuestions, setFinalQuestions] = useState<ExamQuestion[]>([]);
  // 過去に完了した回の一覧・詳細レポート表示用。完了直後に一度だけ見られる結果画面
  // (final-result)だけだと、他のページに移動したりリロードすると二度と見返せなかったため、
  // /api/exam/history（既存API、以前はGuardianView.tsxからしか使われていなかった）を
  // 使って一覧から後からいつでも同じ詳細画面を開けるようにする
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [viewingHistory, setViewingHistory] = useState(false);

  const finishingRef = useRef(false);

  async function loadState() {
    setPhase("checking");
    try {
      const res = await fetch("/api/exam/state");
      const d = (await res.json()) as ExamState & { error?: string };
      if (d.error) throw new Error(d.error);
      setState(d);
      setPhase("select");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch("/api/exam/history");
      const d = await res.json();
      if (!d.error) setHistory(d.history ?? []);
    } catch {
      // 一覧の読み込み失敗は致命的ではないため、セクション自体を出さないだけにする
    }
  }

  useEffect(() => {
    void loadState();
    void loadHistory();
  }, []);

  async function openHistoryDetail(entry: HistoryEntry) {
    setError(null);
    setPhase("starting");
    try {
      const res = await fetch(`/api/exam/questions?examAttemptId=${entry.examAttemptId}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setFinalQuestions((d.questions ?? []) as ExamQuestion[]);
      setVerdict(entry.verdict);
      setExpandedSubject(null);
      setViewingHistory(true);
      setPhase("final-result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function beginPart(p: ExamPart) {
    setError(null);
    setPhase("starting");
    try {
      const res = await fetch("/api/exam/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ part: p }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      if (!d.ready) {
        setPhase("waiting-stock");
        return;
      }
      await openAnswering(d.examAttemptId, p, d.remainingSeconds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function openAnswering(attemptId: number, p: ExamPart, initialRemaining?: number) {
    const qRes = await fetch(`/api/exam/questions?examAttemptId=${attemptId}&part=${p}`);
    const qData = await qRes.json();
    if (qData.error) throw new Error(qData.error);
    const qs = qData.questions as ExamQuestion[];
    const order = [...new Set(qs.map((q) => q.subject))];

    // 再開位置はサーバーに記録済みの解答(yourAnswer)から復元する。科目(ページ)ごとに
    // 全問回答済みかどうかを見て、最初の未完了ページへ飛ぶ
    const restoredAnswers: Record<number, Answer> = {};
    for (const q of qs) {
      if (q.yourAnswer) restoredAnswers[q.id] = q.yourAnswer;
    }
    let resumePage = order.length;
    for (let i = 0; i < order.length; i++) {
      const subjectQuestions = qs.filter((q) => q.subject === order[i]);
      if (!subjectQuestions.every((q) => restoredAnswers[q.id])) {
        resumePage = i;
        break;
      }
    }

    const statusRes = await fetch(`/api/exam/status?examAttemptId=${attemptId}&part=${p}`);
    const statusData = await statusRes.json();
    const remaining = statusData.error ? (initialRemaining ?? 0) : statusData.remainingSeconds;

    setExamAttemptId(attemptId);
    setPart(p);
    setQuestions(qs);
    setSubjectOrder(order);
    setAnswers(restoredAnswers);
    setPage(Math.min(resumePage, Math.max(order.length - 1, 0)));
    setDraft({});
    setRemainingSeconds(remaining);
    finishingRef.current = false;

    if (remaining <= 0 || resumePage >= order.length) {
      // 時間切れ、または全問回答済みなのに完了処理が完了していない
      // （提出直後に通信が切れた等）場合は、今すぐ完了させる
      await finishPart(attemptId, p);
      return;
    }
    setPhase("answering");
  }

  // 残り時間のカウントダウン。0になったら自動的に提出する
  useEffect(() => {
    if (phase !== "answering") return;
    if (remainingSeconds <= 0) {
      if (!finishingRef.current && examAttemptId && part) {
        finishingRef.current = true;
        void finishPart(examAttemptId, part);
      }
      return;
    }
    const id = setTimeout(() => setRemainingSeconds((s) => s - 1), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, remainingSeconds]);

  // サーバー側の残り時間と定期的に同期する（クライアント単独のカウントより信頼できる基準）
  useEffect(() => {
    if (phase !== "answering" || !examAttemptId || !part) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/exam/status?examAttemptId=${examAttemptId}&part=${part}`);
        const d = await res.json();
        if (!d.error) setRemainingSeconds(d.remainingSeconds);
      } catch {
        // 同期に失敗してもローカルのカウントダウンは続ける
      }
    }, 20_000);
    return () => clearInterval(id);
  }, [phase, examAttemptId, part]);

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

  const pageQuestions = questions.filter((q) => q.subject === subjectOrder[page]);
  const requiredSelect = (q: Question) => (q.question_type === "multi" ? 2 : 1);
  const canProceed = pageQuestions.length > 0 && pageQuestions.every((q) => (draft[q.id]?.length ?? 0) === requiredSelect(q));
  const isLastPage = page + 1 >= subjectOrder.length;

  async function submitPage() {
    if (!examAttemptId || !part) return;
    setSubmitting(true);
    try {
      const results = await Promise.all(
        pageQuestions.map(async (q) => {
          const selected = draft[q.id] ?? [];
          const res = await fetch("/api/attempts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question_id: q.id, selected, mode: "exam", profile: "self", exam_attempt_id: examAttemptId }),
          });
          const d = await res.json();
          return { id: q.id, selected, isCorrect: !!d.is_correct };
        }),
      );
      const nextAnswers = { ...answers };
      for (const r of results) nextAnswers[r.id] = { selected: r.selected, isCorrect: r.isCorrect };
      setAnswers(nextAnswers);

      if (isLastPage) {
        await finishPart(examAttemptId, part);
        return;
      }
      const nextPage = page + 1;
      setPage(nextPage);
      setDraft({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function finishPart(attemptId: number, p: ExamPart) {
    setSubmitting(true);
    try {
      const res = await fetch("/api/exam/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examAttemptId: attemptId, part: p }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setFinishedPart(p);
      setPartResult({ bySubject: d.partResult.bySubject, correct: d.partResult.correct, total: d.partResult.total });

      if (d.bothDone && d.verdict) {
        // 両パート分の設問＋そのexam_attempt内での解答をサーバーから取得し直す
        // （午前・午後を別の日に受けていても、この1回のリクエストで両方揃う）
        const allRes = await fetch(`/api/exam/questions?examAttemptId=${attemptId}`);
        const allData = await allRes.json();
        setFinalQuestions((allData.questions ?? []) as ExamQuestion[]);
        setVerdict(d.verdict);
        setPhase("final-result");
      } else {
        setPhase("part-result");
      }
      void loadState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setSubmitting(false);
      finishingRef.current = false;
    }
  }

  if (phase === "checking" || phase === "starting") return <p>読み込み中...</p>;

  if (phase === "error") {
    return (
      <div className="space-y-4">
        <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>
        <button
          onClick={() => void loadState()}
          className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700"
        >
          やり直す
        </button>
      </div>
    );
  }

  if (phase === "waiting-stock") {
    return (
      <div className="space-y-4">
        <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
          実戦模試用の問題を準備中です。裏側で新しい問題を生成しているため、しばらくしてからもう一度お試しください
          （数分〜数時間かかることがあります）。
        </p>
        <button
          onClick={() => void loadState()}
          className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700"
        >
          もう一度確認する
        </button>
      </div>
    );
  }

  if (phase === "select" && state) {
    // 過去の回一覧。古い順に第1回・第2回...と番号を振る（履歴自体は新しい順で表示）
    const sortedAsc = [...(history ?? [])].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    const roundNumberById = new Map(sortedAsc.map((h, i) => [h.examAttemptId, i + 1]));

    const historySection = history && history.length > 0 && (
      <section className="space-y-2">
        <h2 className="font-bold text-stone-700">過去の受験結果</h2>
        {history.map((h) => (
          <button
            key={h.examAttemptId}
            onClick={() => void openHistoryDetail(h)}
            className="flex w-full items-center justify-between gap-3 rounded-2xl bg-white p-4 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <div>
              <p className="font-bold text-stone-800">第{roundNumberById.get(h.examAttemptId)}回</p>
              <p className="text-xs text-stone-500">{new Date(h.completedAt).toLocaleDateString("ja-JP")}</p>
            </div>
            <div className="text-right">
              <p className={`font-bold ${h.verdict.passed ? "text-green-600" : "text-red-600"}`}>
                {h.verdict.passed ? "合格ライン到達" : "不合格ライン"}
              </p>
              <p className="text-sm text-stone-600">
                {h.verdict.totalCorrect}/{h.verdict.totalQuestions}（{Math.round(h.verdict.overallRate * 100)}%）
              </p>
            </div>
          </button>
        ))}
      </section>
    );

    if (state.remainingThisMonth === 0 && !state.hasInProgress) {
      return (
        <div className="space-y-4">
          <h1 className="text-xl font-bold">実戦模試</h1>
          <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
            今月の受験回数（月5回まで）の上限に達しました。来月になるとまた受けられるようになります。
          </p>
          {historySection}
        </div>
      );
    }
    if (!state.canStartNewRound && !state.hasInProgress) {
      return (
        <div className="space-y-4">
          <h1 className="text-xl font-bold">実戦模試</h1>
          <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
            実戦模試は実力測定のため1日1回までです。今日はもう受験済みなので、日をまたぐとまた新しい回を始められます。
          </p>
          {historySection}
        </div>
      );
    }
    const statusOf = (p: ExamPart): ExamStatusValue =>
      (p === "common" ? state.commonStatus : state.specializedStatus) ?? "not_started";
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">実戦模試</h1>
        <p className="text-sm text-stone-600">
          本番と同じ出題数・時間制限（午前140分・午後90分）、一度も出題されていない問題だけで構成される模試です。
          午前・午後は個別に受験でき、両方が完了すると合否判定が出ます。今月あと{state.remainingThisMonth}回受験できます。
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(["common", "specialized"] as ExamPart[]).map((p) => {
            const status = statusOf(p);
            const ready = p === "common" ? state.commonReady : state.specializedReady;
            // 未着手のパートは、最後まですらすら出せるだけの在庫が揃っていない間は
            // 押せないようにする（受験開始後に問題切れで止まる事態を避けるため）
            const notReady = status === "not_started" && !ready;
            const locked = status === "completed" || notReady;
            const label = locked
              ? status === "completed"
                ? "この回では受験済みです"
                : "問題準備中です（しばらくしてから再度お試しください）"
              : status === "in_progress"
                ? "続きから再開する"
                : "タップして開始";
            return (
              <button
                key={p}
                onClick={() => !locked && void beginPart(p)}
                disabled={locked}
                className={`rounded-2xl border-l-4 p-5 text-left shadow-warm transition-all duration-200 ${
                  locked
                    ? "cursor-not-allowed border-stone-300 bg-stone-100 opacity-60"
                    : "border-indigo-400 bg-white hover:-translate-y-0.5 hover:shadow-warm-lg"
                }`}
              >
                <h2 className="font-bold text-indigo-700">{PART_LABEL[p]}</h2>
                <p className="mt-1 text-sm text-stone-600">{label}</p>
              </button>
            );
          })}
        </div>
        {historySection}
      </div>
    );
  }

  if (phase === "part-result" && partResult && finishedPart) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">{PART_LABEL[finishedPart]}の結果</h1>
        <div className="rounded-2xl bg-white p-6 text-center shadow-warm">
          <p className="text-4xl font-bold text-indigo-700">
            {partResult.correct} / {partResult.total}
          </p>
          <p className="mt-1 text-stone-600">得点率 {Math.round((100 * partResult.correct) / Math.max(partResult.total, 1))}%</p>
        </div>
        <p className="rounded-xl bg-indigo-50 p-4 text-sm text-indigo-800">
          もう一方のパートを受けると、この回の合否判定が表示されます。
        </p>
        <button
          onClick={() => void loadState()}
          className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700"
        >
          模試トップへ戻る
        </button>
      </div>
    );
  }

  if (phase === "final-result" && verdict) {
    const bySubjectMap = new Map<string, SubjectScore>();
    const questionsBySubject = new Map<string, { q: ExamQuestion; a: Answer | null }[]>();
    for (const q of finalQuestions) {
      const s = bySubjectMap.get(q.subject) ?? { subject: q.subject, correct: 0, total: 0 };
      s.total++;
      if (q.yourAnswer?.isCorrect) s.correct++;
      bySubjectMap.set(q.subject, s);
      const list = questionsBySubject.get(q.subject) ?? [];
      list.push({ q, a: q.yourAnswer });
      questionsBySubject.set(q.subject, list);
    }
    const rows = [...bySubjectMap.values()].sort((a, b) => a.correct / Math.max(a.total, 1) - b.correct / Math.max(b.total, 1));
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">{viewingHistory ? "過去の受験結果" : "実戦模試 結果"}</h1>
        <div className={`rounded-2xl p-6 text-center shadow-warm ${verdict.passed ? "bg-green-50" : "bg-red-50"}`}>
          <p className={`text-2xl font-bold ${verdict.passed ? "text-green-700" : "text-red-700"}`}>
            {verdict.passed ? "合格ライン到達" : "不合格ライン"}
          </p>
          <p className="mt-2 text-4xl font-bold text-stone-800">
            {verdict.totalCorrect} / {verdict.totalQuestions}
          </p>
          <p className="mt-1 text-stone-600">総合得点率 {Math.round(verdict.overallRate * 100)}%</p>
          {verdict.failedGroups.length > 0 && (
            <p className="mt-2 text-sm text-red-700">0点の科目群: {verdict.failedGroups.join("、")}</p>
          )}
        </div>

        <div className="space-y-2">
          <h2 className="font-bold text-stone-700">科目ごとの得点率</h2>
          {rows.map((r) => {
            const list = questionsBySubject.get(r.subject) ?? [];
            const expanded = expandedSubject === r.subject;
            const accuracy = Math.round((100 * r.correct) / Math.max(r.total, 1));
            return (
              <div key={r.subject} className="rounded-xl bg-white shadow-warm-sm">
                <button
                  onClick={() => setExpandedSubject(expanded ? null : r.subject)}
                  className="flex min-h-12 w-full items-center gap-3 p-3 text-left text-sm"
                >
                  <span className={`font-medium ${accuracy >= 60 ? "text-green-600" : "text-red-600"}`}>
                    {r.correct}/{r.total}
                  </span>
                  <span className="flex-1 font-medium text-stone-800">{r.subject}</span>
                  <span className="shrink-0 text-xs text-stone-400">{expanded ? "閉じる ▲" : "詳細 ▼"}</span>
                </button>
                {expanded && (
                  <div className="space-y-4 border-t border-stone-100 p-4 text-sm">
                    {list.map(({ q, a }, i) => (
                      <div key={q.id} className={i > 0 ? "border-t border-stone-100 pt-4" : ""}>
                        <div className="mb-2 flex items-start gap-2">
                          <span className={`shrink-0 font-bold ${a?.isCorrect ? "text-green-600" : "text-red-600"}`}>
                            {a?.isCorrect ? "○" : "×"}
                          </span>
                          <div>
                            {q.case_text && (
                              <p className="mb-1 rounded bg-stone-50 p-2 leading-relaxed">
                                <span className="mr-1 font-bold">〔事例〕</span>
                                {q.case_text}
                              </p>
                            )}
                            <p className="font-medium leading-relaxed">{q.stem}</p>
                          </div>
                        </div>
                        <ol className="space-y-2">
                          {q.options.map((opt, oi) => {
                            const n = oi + 1;
                            const isAnswer = q.correct.includes(n);
                            const chosen = a?.selected.includes(n) ?? false;
                            let style = "border-stone-200 bg-white opacity-70";
                            if (isAnswer) style = "border-green-500 bg-green-50";
                            else if (chosen) style = "border-red-400 bg-red-50";
                            return (
                              <li key={n} className={`rounded-xl border p-3 leading-relaxed ${style}`}>
                                <span className="mr-2 font-bold">{n}</span>
                                {opt}
                                {isAnswer && <span className="ml-2 text-green-600">✓ 正答</span>}
                                {chosen && !isAnswer && <span className="ml-2 text-red-500">あなたの解答</span>}
                              </li>
                            );
                          })}
                        </ol>
                        <ol className="mt-2 space-y-1.5">
                          {q.explanations.map((ex, ei) => (
                            <li key={ei} className="flex gap-2 leading-relaxed text-stone-600">
                              <span
                                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                                  q.correct.includes(ei + 1) ? "bg-green-600 text-white" : "bg-stone-300 text-stone-700"
                                }`}
                              >
                                {ei + 1}
                              </span>
                              <span>{ex}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          <button
            onClick={() => void loadState()}
            className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700"
          >
            模試トップへ戻る
          </button>
          <Link
            href="/stats"
            className="inline-flex min-h-12 items-center justify-center rounded-xl border border-indigo-600 px-5 py-3 font-medium text-indigo-700 hover:bg-indigo-50"
          >
            成績を見る
          </Link>
        </div>
      </div>
    );
  }

  // --- answering ---
  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{part && PART_LABEL[part]}</h1>
        <span
          className={`rounded-full px-3 py-1 text-sm font-bold ${
            remainingSeconds < 300 ? "bg-red-100 text-red-700" : "bg-indigo-100 text-indigo-700"
          }`}
        >
          残り {formatClock(Math.max(0, remainingSeconds))}
        </span>
      </div>
      <div>
        <div className="flex items-center justify-between text-sm text-stone-500">
          <span>
            {page + 1} / {subjectOrder.length} 分野目
            <span className="ml-3 rounded bg-stone-200 px-2 py-0.5 text-xs">{subjectOrder[page]}</span>
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-stone-200">
          <div
            className="h-full rounded-full bg-indigo-500 transition-all"
            style={{ width: `${Math.round((100 * (page + 1)) / subjectOrder.length)}%` }}
          />
        </div>
      </div>

      {pageQuestions.map((q) => {
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
          onClick={submitPage}
          disabled={!canProceed || submitting}
          className="min-h-12 w-full rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white hover:bg-indigo-700 transition-colors disabled:opacity-40 sm:w-auto"
        >
          {submitting ? "送信中..." : isLastPage ? "提出して結果を見る" : "次の分野へ"}
        </button>
      </div>
      {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
