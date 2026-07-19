"use client";

import { useEffect, useState } from "react";

type PageDetail = { id: number; book: string; page_number: number; title: string | null; url: string };

/**
 * 国試ナビのページ画像をモーダル表示する共通コンポーネント。/searchの検索結果からも、
 * 解説画面の「関連する国試ナビのページ」からも同じものを使う。事前レンダリング画像を
 * <img>で出すだけなので、拡大はブラウザ標準のピンチズームに任せる（react-pdf等は導入しない）。
 */
export default function NavPageViewer({ navPageId, onClose }: { navPageId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/nav/page?id=${navPageId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        setDetail(d as PageDetail);
      })
      .catch(() => {
        if (!cancelled) setError("ページの読み込みに失敗しました。時間をおいて再度お試しください。");
      });
    return () => {
      cancelled = true;
    };
  }, [navPageId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white shadow-warm-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-stone-100 p-3">
          <div className="min-w-0">
            {detail && (
              <>
                <p className="truncate text-sm font-bold text-stone-800">{detail.title || detail.book}</p>
                <p className="text-xs text-stone-500">
                  {detail.book} p.{detail.page_number}
                </p>
              </>
            )}
          </div>
          <button
            onClick={onClose}
            className="min-h-9 shrink-0 rounded-lg border border-stone-300 px-3 py-1 text-xs text-stone-600 hover:bg-stone-100"
          >
            閉じる
          </button>
        </div>
        <div className="p-2">
          {error && <p className="p-3 text-sm text-red-600">{error}</p>}
          {!error && !detail && <p className="p-6 text-center text-sm text-stone-500">読み込み中...</p>}
          {detail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={detail.url} alt={detail.title || detail.book} className="mx-auto w-full rounded-lg" />
          )}
        </div>
      </div>
    </div>
  );
}
