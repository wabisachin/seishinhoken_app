"use client";

import { useEffect, useState } from "react";
import type { Citation } from "@/lib/types";
import { dedupeCitations } from "@/lib/citations";
import NavPageViewer from "../search/NavPageViewer";

/**
 * 選択肢ごとの解説＋その選択肢の正誤判定に使った教科書の根拠を対応付けて表示する。
 * citations[].supports に選択肢番号(1始まり)が入っている場合のみその選択肢の直下に紐付け、
 * supportsが無い/空の引用は「その他の根拠」としてまとめて末尾に出す（旧データ・LLMが
 * 対応付けを省略したケースへのフォールバック）。
 */
type NavPageRef = { id: number; book: string; page_number: number; title: string | null };

export default function ExplanationList({
  questionId,
  explanations,
  correct,
  citations,
  keyPoints,
  variant = "card",
}: {
  // 解説画面で関連する国試ナビのページを探すために使う。未指定の場合はセクション自体を出さない
  questionId?: number;
  explanations: string[];
  correct: number[];
  citations: Citation[] | null;
  keyPoints?: string | null;
  // "card": 単独ページ用に見出し付きの白カードで囲む。"inline": 既に白カードの中に
  // 埋め込まれる場合用に、外枠無しでコンパクトに表示する（AllSubjectsQuizの1問ずつの
  // カード内など、カードの中にカードが二重に見えるのを避けるため）
  variant?: "card" | "inline";
}) {
  // 一度に開けるのは1つだけ（アコーディオン）。複数開けると根拠がどれも半端に見えて
  // 読みにくいため、新しく開いたら前のものは自動的に閉じる
  const [expanded, setExpanded] = useState<number | null>(null);

  // 関連する国試ナビのページ。questions行にlazy-cacheされているのでAPI呼び出しは
  // 問題ごとに実質1回だけ（2回目以降はキャッシュ済みの結果がすぐ返る）
  const [navPage, setNavPage] = useState<NavPageRef | null>(null);
  const [navPageViewerOpen, setNavPageViewerOpen] = useState(false);
  useEffect(() => {
    if (!questionId) return;
    let cancelled = false;
    setNavPage(null);
    fetch("/api/nav/related", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && !d.error) setNavPage(d.navPage ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [questionId]);

  const toggle = (chunkId: number) => {
    setExpanded((prev) => (prev === chunkId ? null : chunkId));
  };

  const dedupedCitations = citations ? dedupeCitations(citations) : [];
  const citationsFor = (optionIndex: number) => dedupedCitations.filter((c) => c.supports?.includes(optionIndex));
  const generalCitations = dedupedCitations.filter((c) => !c.supports || c.supports.length === 0);

  // 引用文中の該当箇所(quote)を太字強調する。1文字でも本文とズレて一致しない場合は
  // 強調せずそのまま表示する（LLMの引用がわずかに不正確でも表示自体は壊れないように）
  const highlight = (excerpt: string, quote: string | undefined) => {
    if (!quote) return excerpt;
    const idx = excerpt.indexOf(quote);
    if (idx === -1) return excerpt;
    return (
      <>
        {excerpt.slice(0, idx)}
        <strong className="rounded bg-amber-200/70 font-bold text-stone-900">
          {excerpt.slice(idx, idx + quote.length)}
        </strong>
        {excerpt.slice(idx + quote.length)}
      </>
    );
  };

  const isCard = variant === "card";

  return (
    <>
      <div className={isCard ? "rounded-2xl bg-white p-5 shadow-warm" : ""}>
        {isCard && <h3 className="mb-3 font-bold text-indigo-700">選択肢ごとの解説</h3>}
        <ol className={isCard ? "space-y-3" : "mt-3 space-y-1.5"}>
          {explanations.map((ex, i) => {
            const related = citationsFor(i + 1);
            return (
              <li key={i} className={`text-sm leading-relaxed ${isCard ? "" : "text-stone-600"}`}>
                <div className="flex gap-2">
                  <span
                    className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      correct.includes(i + 1) ? "bg-green-600 text-white" : "bg-stone-300 text-stone-700"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span>{ex}</span>
                </div>
                {related.length > 0 && (
                  <div className="ml-7 mt-1.5 flex flex-wrap gap-1.5">
                    {related.map((c) => (
                      <button
                        key={c.chunk_id}
                        onClick={() => toggle(c.chunk_id)}
                        className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700"
                      >
                        根拠: {c.book} p.{c.page_start}
                        {c.page_end !== c.page_start ? `–${c.page_end}` : ""}
                        {expanded === c.chunk_id ? " －" : " ＋"}
                      </button>
                    ))}
                  </div>
                )}
                {related
                  .filter((c) => expanded === c.chunk_id)
                  .map((c) => {
                    const quote = c.quotes?.find((q) => q.option === i + 1)?.quote;
                    return (
                      <p
                        key={c.chunk_id}
                        className="ml-7 mt-1.5 whitespace-pre-wrap rounded-xl bg-stone-50 p-3 text-xs leading-relaxed text-stone-600"
                      >
                        {highlight(c.excerpt, quote)}
                      </p>
                    );
                  })}
              </li>
            );
          })}
        </ol>
      </div>

      {keyPoints && (
        <div className={isCard ? "rounded-2xl bg-amber-50 p-5 shadow-warm" : "mt-3 rounded-xl bg-amber-50 p-3"}>
          <h3 className={isCard ? "mb-2 font-bold text-amber-800" : "mb-1 text-sm font-bold text-amber-800"}>
            押さえておくべきポイント
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{keyPoints}</p>
        </div>
      )}

      {generalCitations.length > 0 && (
        <div className={isCard ? "rounded-2xl bg-white p-5 shadow-warm" : "mt-3"}>
          <h3 className={isCard ? "mb-2 font-bold text-stone-700" : "mb-1 text-sm font-bold text-stone-700"}>
            その他の根拠
          </h3>
          <ul className={isCard ? "space-y-2" : "space-y-1.5"}>
            {generalCitations.map((c) => {
              const isExpanded = expanded === c.chunk_id;
              return (
                <li key={c.chunk_id} className="rounded-xl border border-stone-100">
                  <button
                    onClick={() => toggle(c.chunk_id)}
                    className="flex min-h-10 w-full items-center gap-2 p-2 text-left text-sm text-stone-600"
                  >
                    <span className="text-indigo-300">・</span>
                    <span className="flex-1">
                      {c.book} p.{c.page_start}
                      {c.page_end !== c.page_start ? `–${c.page_end}` : ""}
                    </span>
                    <span className="shrink-0 text-xs font-bold text-indigo-500">{isExpanded ? "－" : "＋"}</span>
                  </button>
                  {isExpanded && (
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

      {navPage && (
        <div className={isCard ? "rounded-2xl bg-white p-5 shadow-warm" : "mt-3"}>
          <h3 className={isCard ? "mb-2 font-bold text-stone-700" : "mb-1 text-sm font-bold text-stone-700"}>
            関連する国試ナビのページ
          </h3>
          <button
            onClick={() => setNavPageViewerOpen(true)}
            className="flex min-h-10 w-full items-center gap-2 rounded-xl border border-stone-100 p-2 text-left text-sm text-stone-600 hover:bg-stone-50"
          >
            <span className="text-indigo-300">🖼</span>
            <span className="flex-1">
              {navPage.title || navPage.book} ({navPage.book} p.{navPage.page_number})
            </span>
            <span className="shrink-0 text-xs font-bold text-indigo-500">開く</span>
          </button>
        </div>
      )}
      {navPageViewerOpen && navPage && (
        <NavPageViewer navPageId={navPage.id} onClose={() => setNavPageViewerOpen(false)} />
      )}
    </>
  );
}
