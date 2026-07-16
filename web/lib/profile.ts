// ログイン機能ではなく、同じアプリを本人・応援する人（家族やテスター）が同時に
// 使っても回答履歴が混ざらないようにするための、ブラウザ側の自己申告区分。
export type UserProfile = "self" | "guardian";
const KEY = "app_user_profile";

export function getStoredProfile(): UserProfile | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(KEY);
  return v === "self" || v === "guardian" ? v : null;
}

export function setStoredProfile(p: UserProfile) {
  localStorage.setItem(KEY, p);
}
