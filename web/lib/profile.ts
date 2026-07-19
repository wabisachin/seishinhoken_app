// ログイン機能ではなく、同じアプリを本人・動作テスト用・応援する人が同時に
// 使っても学習データが混ざらないようにするための、ブラウザ側の自己申告区分。
// "test"は本人以外が自由に動作確認できるサンドボックス（本人の学習データとは
// DB上のprofile列で完全に分離される。詳細はweb/lib/questionSupply.ts等を参照）。
export type UserProfile = "self" | "guardian" | "test";
const KEY = "app_user_profile";

export function getStoredProfile(): UserProfile | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(KEY);
  return v === "self" || v === "guardian" || v === "test" ? v : null;
}

export function setStoredProfile(p: UserProfile) {
  localStorage.setItem(KEY, p);
}

export function clearStoredProfile() {
  localStorage.removeItem(KEY);
}

// クイズの中断セッション・ホーム画面のおすすめキャッシュ等、モードごとに別々に
// 保持したいlocalStorageキーの名前空間化。切替時にクリアする方式だと将来追加される
// キーをクリアし忘れるリスクがあるため、キー自体にprofileを埋め込む方式にする。
// profile未確定（初回訪問時等）は"anon"にフォールバックする。
export function profileScopedKey(base: string): string {
  return `${base}_${getStoredProfile() ?? "anon"}`;
}

// APIルート（サーバー側）用。クエリパラメータ/bodyで受け取ったprofile文字列が
// 有効な値かどうかを検証する。学習データを扱うルートはこれで検証したprofileを
// 必須引数として各lib関数に渡す（デフォルト値へのフォールバックは行わない）。
export function isValidProfile(v: string | null | undefined): v is UserProfile {
  return v === "self" || v === "guardian" || v === "test";
}
