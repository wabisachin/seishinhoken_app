"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getStoredProfile, type UserProfile } from "@/lib/profile";

/**
 * ヘッダーのタイトルリンク先とナビタブは、プロフィール（本人/応援する人）で出し分ける。
 * 応援する人は演習ページ(ホーム・実戦模試)に入れない（ProfileGateでブロックされる）ため、
 * そもそも押せないタブを並べる意味が無い。応援する人にとっての「ホーム」は成績ページ
 * （app/(main)/stats/GuardianView.tsx）なので、タイトルリンクもそちらに向ける。
 */
function useIsGuardian(): boolean {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    setProfile(getStoredProfile());
  }, []);
  return profile === "guardian";
}

export function TitleLink() {
  const isGuardian = useIsGuardian();
  return (
    <Link href={isGuardian ? "/stats" : "/"} className="text-base font-bold leading-tight tracking-wide sm:text-lg">
      精神保健福祉士 試験対策
    </Link>
  );
}

export function NavLinks() {
  const isGuardian = useIsGuardian();
  return (
    <nav className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm font-medium text-indigo-50">
      {!isGuardian && (
        <>
          <Link href="/" className="transition-colors hover:text-white">
            ホーム
          </Link>
          <Link href="/full-mock" className="transition-colors hover:text-white">
            実戦模試
          </Link>
          <Link href="/stats" className="transition-colors hover:text-white">
            成績
          </Link>
          {/* 本人モードはスマホの表示幅の都合でバナー最大5個に抑えている。
              教科書検索を追加する代わりに合格ガイドはバナーから外し、使い方ページ内の
              リンクに移設した（応援する人はもともと2バナーのみで余裕があるため残す） */}
          <Link href="/search" className="transition-colors hover:text-white">
            教科書検索
          </Link>
        </>
      )}
      {isGuardian && (
        <Link href="/pass-guide" className="transition-colors hover:text-white">
          合格ガイド
        </Link>
      )}
      <Link href="/guide" className="transition-colors hover:text-white">
        使い方
      </Link>
    </nav>
  );
}
