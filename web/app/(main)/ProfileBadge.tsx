"use client";

import { useEffect, useState } from "react";
import { clearStoredProfile, getStoredProfile, type UserProfile } from "@/lib/profile";

// 本人・動作テスト用・応援する人の3択。押すたびに次の候補へ回すのではなく、
// クリックするとProfileGateの選択画面（3択）に戻す方式にする（誤操作で意図しない
// モードへ切り替わるのを避けるため。切替は「一度選択画面に戻って選び直す」形にする）。
const PROFILE_LABEL: Record<UserProfile, string> = { self: "ご本人", guardian: "応援する人", test: "動作テスト用" };

export default function ProfileBadge() {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    setProfile(getStoredProfile());
  }, []);

  if (!profile) return null;

  function switchProfile() {
    clearStoredProfile();
    // ProfileGateの選択画面を確実に出すため、ページ全体を読み込み直す
    window.location.href = "/";
  }

  return (
    <button
      onClick={switchProfile}
      className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-white transition-colors ${
        profile === "test" ? "bg-amber-500/70 hover:bg-amber-500/90" : "bg-white/20 hover:bg-white/30"
      }`}
    >
      <span aria-hidden>⇄</span>
      {PROFILE_LABEL[profile]}
    </button>
  );
}
