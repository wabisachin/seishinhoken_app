"use client";

import { useEffect, useState } from "react";
import { getStoredProfile, setStoredProfile, type UserProfile } from "@/lib/profile";

export default function ProfileGate({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null | "checking">("checking");

  useEffect(() => {
    setProfile(getStoredProfile());
  }, []);

  function choose(p: UserProfile) {
    setStoredProfile(p);
    setProfile(p);
  }

  if (profile === "checking") return null;

  if (profile === null) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-12">
        <h1 className="text-lg font-bold">はじめに、あなたについて教えてください</h1>
        <p className="text-sm leading-relaxed text-stone-600">
          ログインやパスワードは不要です。ご本人と応援する人が同時にこのアプリを使っても、
          成績や復習の記録が混ざらないようにするための設定です。
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            onClick={() => choose("self")}
            className="rounded-2xl border-l-4 border-indigo-400 bg-white p-5 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-indigo-700">ご本人</h2>
            <p className="mt-1 text-sm text-stone-600">試験対策として問題を解きます</p>
          </button>
          <button
            onClick={() => choose("guardian")}
            className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 text-left shadow-warm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-warm-lg"
          >
            <h2 className="font-bold text-violet-700">応援する人</h2>
            <p className="mt-1 text-sm text-stone-600">成績を見るだけで、問題は解きません</p>
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
