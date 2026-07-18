"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Question } from "@/lib/types";
import { getStoredProfile } from "@/lib/profile";

const PAGE_SIZE = 3;
const STORAGE_KEY = "quiz_session_mock_v1";
// 1科目ぶん(PAGE_SIZE問)を集めるための、1問あたりの生成リトライ上限
// （科目別演習と同じ /api/quiz/next を使っており、却下が続く場合の保険も同じ考え方）
const MAX_NEXT_ATTEMPTS = 15;

// 本番の試験は午前(共通科目・社会福祉士と合同)/午後(専門科目・精神保健福祉士のみ)の
// 2部制（exam_pdfのsource_fileで sp_am_*=common, se_pm_*=specialized と確認済み）。
// ミニ模試もそれに合わせ、どちらを受けるか選んでもらう。
type SessionKind = "common" | "specialized";
const SESSION_LABEL: Record<SessionKind, string> = {
  common: "午前の部（共通科目）",
  specialized: "午後の部（専門科目）",
};

type Answer = { selected: number[]; isCorrect: boolean };
type Persisted = {
  sessionKind: SessionKind;
  subjectOrder: string[];
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

/**
 * 全分野ミニ模試も科目別演習と全く同じロジック（questionSupply.ts の
 * getOrGenerateNext）で1科目ぶんを揃える。過去に貯まった問題を並べるのではなく、
 * その科目のアクティブ問題数に応じて「50問まで毎回新規／200問到達で新規停止」の
 * 同じ確率で新規生成するかどうかが決まる。1ページ=1科目のPAGE_SIZE問を、
 * 科目内で重複しないよう逐次（順番に）取得する。
 */
async function fetchSubjectBatch(
  subject: string,
  count: number,
  onAttempt: ((n: number) => void) | null,
): Promise<Question[]> {
  const picked: Question[] = [];
  const excludeIds: number[] = [];
  for (let slot = 0; slot < count; slot++) {
    let gotSlot = false;
    for (let attempt = 0; attempt < MAX_NEXT_ATTEMPTS; attempt++) {
      const { question, exhausted } = await requestNextQuestion(subject, excludeIds);
      if (question) {
        picked.push(question);
        excludeIds.push(question.id);
        gotSlot = true;
        break;
      }
      if (exhausted) {
        // この科目はこれ以上出せない。今集まっている分だけで妥協する
        gotSlot = true;
        break;
      }
      onAttempt?.(attempt + 1);
    }
    if (!gotSlot) {
      throw new Error(`「${subject}」の出題準備に時間がかかりすぎています。時間をおいて再度お試しください。`);
    }
    if (picked.length <= slot) break; // exhaustedで打ち切られた場合、これ以上slotを増やしても無駄
  }
  return picked;
}

async function fetchSubjectOrder(sessionKind: SessionKind): Promise<string[]> {
  const res = await fetch("/api/subjects");
  const d = await res.json();
  const subjects = (d.subjects ?? []) as { subject: string; kind: string | null; taxonomy_items: number }[];
  return subjects
    .filter((s) => s.taxonomy_items > 0 && s.kind === sessionKind)
    .sort((a, b) => a.subject.localeCompare(b.subject, "ja"))
    .map((s) => s.subject);
}

type Phase =
  | "checking"
  | "select-session"
  | "resume-prompt"
  | "loading"
  | "generating"
  | "answering"
  | "finished"
  | "empty";

export default function MockQuiz() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [sessionKind, setSessionKind] = useState<SessionKind>("common");
  const [subjectOrder, setSubjectOrder] = useState<string[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Record<number, number[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<Persisted | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
  const [generatingAttempt, setGeneratingAttempt] = useState(0);
  // 科目ごとに1回だけ取得を開始し、結果(または進行中のPromise)をキャッシュする。
  // ページ送りのたびに「その場で次を生成」するのではなく、模試が始まったら
  // バックグラウンドのランナーが最後の科目まで順番に生成を進め続けるため、
  // ユーザーが今の3問を解いている間に何ページも先まで用意が進む。
  const batchCacheRef = useRef<Map<string, Promise<Question[]>>>(new Map());
  const runnerActiveRef = useRef(false);
  const cancelledRef = useRef(false);

  function ensureBatchStarted(subject: string, onAttempt: ((n: number) => void) | null = null): Promise<Question[]> {
    let p = batchCacheRef.current.get(subject);
    if (!p) {
      p = fetchSubjectBatch(subject, PAGE_SIZE, onAttempt).catch((e) => {
        // 失敗をキャッシュしたままにすると、実際にそのページへ来た時も
        // リトライ無しで即エラーになってしまう。消しておいて次回は新規に試みさせる
        batchCacheRef.current.delete(subject);
        throw e;
      });
      batchCacheRef.current.set(subject, p);
    }
    return p;
  }

  async function runBackgroundRunner(order: string[], startIndex: number) {
    if (runnerActiveRef.current) return;
    runnerActiveRef.current = true;
    for (let i = startIndex; i < order.length; i++) {
      if (cancelledRef.current) break;
      try {
        await ensureBatchStarted(order[i]);
      } catch {
        // 失敗はここでは無視する。実際にそのページへ進む時にforeground側が再試行・エラー表示する
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

  useEffect(() => {
    const persisted = loadPersisted();
    const unfinished = persisted && Object.keys(persisted.answers).length < persisted.questions.length;
    if (unfinished) {
      setPendingResume(persisted);
      setPhase("resume-prompt");
    } else {
      setPhase("select-session");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startFresh(kind: SessionKind) {
    clearPersisted();
    setSessionKind(kind);
    setPhase("loading");
    setError(null);
    setGeneratingAttempt(0);
    try {
      const order = await fetchSubjectOrder(kind);
      if (order.length === 0) {
        setError("出題できる科目がありません。");
        setPhase("empty");
        return;
      }
      setSubjectOrder(order);
      const first = await fetchSubjectBatch(order[0], PAGE_SIZE, (n) => {
        setPhase("generating");
        setGeneratingAttempt(n);
      });
      if (first.length === 0) {
        setError("問題プールが空です。科目別演習で問題を生成してから試してください。");
        setPhase("empty");
        return;
      }
      setQuestions(first);
      setAnswers({});
      setPage(0);
      setDraft({});
      savePersisted({ sessionKind: kind, subjectOrder: order, questions: first, answers: {}, page: 0, savedAt: Date.now() });
      setPhase("answering");
      void runBackgroundRunner(order, 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("empty");
    }
  }

  function resume() {
    if (!pendingResume) return;
    setSessionKind(pendingResume.sessionKind);
    setSubjectOrder(pendingResume.subjectOrder);
    setQuestions(pendingResume.questions);
    setAnswers(pendingResume.answers);
    setPage(pendingResume.page);
    setDraft({});
    setPhase("answering");
    void runBackgroundRunner(pendingResume.subjectOrder, pendingResume.page + 1);
  }

  function discardAndStart() {
    setPendingResume(null);
    setPhase("select-session");
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
  const requiredSelect = (q: Question) => (q.question_type === "multi" ? 2 : 1);
  const canProceed =
    pageQuestions.length > 0 && pageQuestions.every((q) => (draft[q.id]?.length ?? 0) === requiredSelect(q));
  const isLastPage = page + 1 >= subjectOrder.length;

  async function submitPage() {
    setSubmitting(true);
    try {
      const results = await Promise.all(
        pageQuestions.map(async (q) => {
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

      if (isLastPage) {
        clearPersisted();
        setPhase("finished");
        return;
      }

      setSubmitting(false);
      setError(null);
      setPhase("loading");
      setGeneratingAttempt(0);
      const nextSubject = subjectOrder[page + 1];
      // バックグラウンドランナーが既に用意できていれば即座に返る。まだなら
      // （ユーザーが解答が早く、ランナーがまだそこまで追いついていない場合）ここで待つ
      const nextBatch = await ensureBatchStarted(nextSubject, (n) => {
        setPhase("generating");
        setGeneratingAttempt(n);
      });
      const nextQuestions = [...questions, ...nextBatch];
      const nextPage = page + 1;
      setQuestions(nextQuestions);
      setPage(nextPage);
      setDraft({});
      savePersisted({ sessionKind, subjectOrder, questions: nextQuestions, answers: nextAnswers, page: nextPage, savedAt: Date.now() });
      setPhase("answering");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("answering");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "checking") return null;

  if (phase === "select-session") {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">全分野ミニ模試</h1>
        <p className="text-sm text-stone-600">
          本番の試験は午前（共通科目・社会福祉士と合同）と午後（専門科目）の2部制です。どちらを受けますか？
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            onClick={() => void startFresh("common")}
            className="rounded-2xl border-l-4 border-indigo-400 bg-white p-5 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-indigo-700">{SESSION_LABEL.common}</h2>
            <p className="mt-1 text-sm text-stone-600">社会福祉士と共通の科目。ソーシャルワークの基盤、医学概論、社会保障など。</p>
          </button>
          <button
            onClick={() => void startFresh("specialized")}
            className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-violet-700">{SESSION_LABEL.specialized}</h2>
            <p className="mt-1 text-sm text-stone-600">精神保健福祉士のみの専門科目。精神医学、精神保健福祉の原理など。</p>
          </button>
        </div>
      </div>
    );
  }

  if (phase === "resume-prompt" && pendingResume) {
    const done = Object.keys(pendingResume.answers).length;
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">全分野ミニ模試（{SESSION_LABEL[pendingResume.sessionKind]}）</h1>
        <div className="rounded-2xl bg-amber-50 p-5 shadow-warm">
          <p className="text-sm text-amber-800">
            前回途中だった模試があります（{done} / {pendingResume.questions.length} 問まで解答済み）。続きから再開しますか？
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-3">
            <button
              onClick={resume}
              className="min-h-12 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              続きから再開する
            </button>
            <button
              onClick={discardAndStart}
              className="min-h-12 rounded-xl border border-stone-300 px-4 py-3 text-sm text-stone-600 transition-colors hover:bg-stone-100"
            >
              新しく始める
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

    // 詳細（問題ごとの解答・解説）は科目単位でまとめ、「詳細」ボタンを押した科目だけ
    // 展開する。模試は問題数が多いため、常に全問展開だと情報量が多すぎるための工夫。
    const questionsBySubject = new Map<string, { q: Question; a: Answer }[]>();
    for (const q of questions) {
      const a = answers[q.id];
      if (!a) continue;
      const list = questionsBySubject.get(q.subject) ?? [];
      list.push({ q, a });
      questionsBySubject.set(q.subject, list);
    }

    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">模試結果（{SESSION_LABEL[sessionKind]}）</h1>
        <div className="rounded-2xl bg-white p-6 text-center shadow-warm">
          <p className="text-4xl font-bold text-indigo-700">
            {overallCorrect} / {overallTotal}
          </p>
          <p className="mt-1 text-stone-600">
            総合正答率 {Math.round((100 * overallCorrect) / Math.max(overallTotal, 1))}%
          </p>
        </div>

        <div className="overflow-hidden rounded-2xl bg-white shadow-warm">
          <table className="w-full text-sm">
            <thead className="bg-stone-100 text-left">
              <tr>
                <th className="px-4 py-2">科目</th>
                <th className="px-3 py-2 text-right">正解</th>
                <th className="px-3 py-2 text-right">出題</th>
                <th className="px-3 py-2 text-right">得点率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.subject} className="border-t border-stone-100">
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
          <h2 className="font-bold text-stone-700">科目ごとの解答・解説</h2>
          <p className="text-xs text-stone-400">
            科目名を押すと、その科目の全問の解答・解説がまとめて表示されます（教科書の根拠・押さえるべきポイントは、
            後で復習モードから見られるようここでは省略しています）。
          </p>
          {rows.map((r) => {
            const list = questionsBySubject.get(r.subject) ?? [];
            const expanded = expandedSubject === r.subject;
            return (
              <div key={r.subject} className="rounded-xl bg-white shadow-warm-sm">
                <button
                  onClick={() => setExpandedSubject(expanded ? null : r.subject)}
                  className="flex min-h-12 w-full items-center gap-3 p-3 text-left text-sm"
                >
                  <span className={`font-medium ${r.accuracy >= 60 ? "text-green-600" : "text-red-600"}`}>
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
                          <span className={`shrink-0 font-bold ${a.isCorrect ? "text-green-600" : "text-red-600"}`}>
                            {a.isCorrect ? "○" : "×"}
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
                            const chosen = a.selected.includes(n);
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
            onClick={() => setPhase("select-session")}
            className="min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
          >
            もう一度
          </button>
          <Link
            href="/stats"
            className="inline-flex min-h-12 items-center justify-center rounded-xl border border-indigo-600 px-5 py-3 font-medium text-indigo-700 transition-colors hover:bg-indigo-50"
          >
            成績を見る
          </Link>
        </div>
      </div>
    );
  }

  // --- answering: 3問まとめて表示、即時フィードバック無し ---
  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      <h1 className="text-lg font-bold">全分野ミニ模試（{SESSION_LABEL[sessionKind]}）</h1>
      <div className="flex items-center justify-between text-sm text-stone-500">
        <span>
          {page + 1} / {subjectOrder.length} 分野目
          <span className="ml-3 rounded bg-stone-200 px-2 py-0.5 text-xs">{subjectOrder[page]}</span>
        </span>
        <span className="hidden sm:inline">結果はまとめて最後に表示されます</span>
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
          {submitting ? "送信中..." : isLastPage ? "結果を見る" : "次の3問へ"}
        </button>
      </div>
      {error && <p className="rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
