"use client";

import { useEffect, useState } from "react";
import { clearStoredProfile, getStoredProfile, type UserProfile } from "@/lib/profile";

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
      className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-white/20 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/30"
    >
      <span aria-hidden>⇄</span>
      {profile === "self" ? "ご本人" : "応援する人"}
    </button>
  );
}
