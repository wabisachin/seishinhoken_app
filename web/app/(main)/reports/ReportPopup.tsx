"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getStoredProfile } from "@/lib/profile";

type UnreadInfo = { hasUnread: boolean; reportId: number | null; periodMonth: string | null };

function formatMonth(dateStr: string) {
  const [y, m] = dateStr.slice(0, 7).split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

/**
 * 新しい振り返りレポートが発行されたら、ダッシュボードでポップアップして知らせる。
 * 応援する人はダッシュボードに来ない（ProfileGateで/statsへ流される）ため、本人・
 * 動作テスト用のみが対象。×やダイアログ外クリックでは消えない ── 実際にレポートを
 * 開く(read_atが立つ)まで、セッションをまたいで毎回再表示する（中身を見てもらうことを
 * 優先するユーザー指示のため）。
 */
export default function ReportPopup() {
  const router = useRouter();
  const [info, setInfo] = useState<UnreadInfo | null>(null);

  useEffect(() => {
    const profile = getStoredProfile();
    if (profile !== "self" && profile !== "test") return;
    fetch(`/api/reports/unread?profile=${profile}`)
      .then((r) => r.json())
      .then((d: UnreadInfo) => {
        if (d.hasUnread) setInfo(d);
      })
      .catch(() => {});
  }, []);

  if (!info || !info.hasUnread || info.reportId === null) return null;

  function openReport() {
    const profile = getStoredProfile();
    router.push(`/reports/${info!.reportId}?profile=${profile}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="max-w-sm rounded-2xl bg-white p-5 shadow-warm-lg">
        <h2 className="font-bold text-indigo-700">📋 新しい振り返りレポートが届きました</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          {info.periodMonth
            ? `${formatMonth(info.periodMonth)}の振り返りと、次の学習プランができています。`
            : "新しい振り返りレポートができています。"}
        </p>
        <button
          onClick={openReport}
          className="mt-4 min-h-11 w-full rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700"
        >
          レポートを見る
        </button>
      </div>
    </div>
  );
}
