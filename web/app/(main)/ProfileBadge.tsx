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
      className="rounded-full bg-white/15 px-3 py-1 text-xs text-indigo-50 transition-colors hover:bg-white/25"
      title="タップして切り替え"
    >
      {profile === "self" ? "ご本人" : "応援する人"} ▾
    </button>
  );
}
