"use client";

import { useState } from "react";
import NavPageViewer from "./NavPageViewer";

type Result = { id: number; book: string; page_number: number; title: string | null; similarity: number };

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/nav/search?q=${encodeURIComponent(q)}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setResults(d.results ?? []);
    } catch {
      setError("検索に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">教科書検索</h1>
      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <p className="text-sm leading-relaxed text-stone-600">
          調べたい言葉を入力すると、「見て覚える！国試ナビ」から意味の近いページを探して画像で表示します。
        </p>
        <form onSubmit={search} className="mt-3 flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例: 地域移行支援、向精神薬の副作用"
            className="min-h-11 flex-1 rounded-xl border border-stone-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="min-h-11 shrink-0 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "検索中..." : "検索"}
          </button>
        </form>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {results && (
        <section className="space-y-2">
          {results.length === 0 && <p className="text-sm text-stone-500">該当するページが見つかりませんでした。</p>}
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => setOpenId(r.id)}
              className="flex w-full items-center justify-between gap-3 rounded-2xl bg-white p-4 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-stone-800">{r.title || r.book}</p>
                <p className="mt-0.5 text-xs text-stone-500">
                  {r.book} p.{r.page_number}
                </p>
              </div>
              <span className="shrink-0 text-xs text-stone-400">開く &gt;</span>
            </button>
          ))}
        </section>
      )}

      {openId !== null && <NavPageViewer navPageId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
