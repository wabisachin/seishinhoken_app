import { supabase } from "./supabase";

const BUCKET = "nav-pages";
const SIGNED_URL_TTL_SEC = 300;

/**
 * 国試ナビのページ画像は著作権のある市販教材のため、バケットは非公開にしてある
 * （scripts/index_nav_pages.py参照）。表示のたびにサーバー経由で短命の署名付きURLを発行する。
 */
export async function getNavPageImageUrl(imagePath: string): Promise<string> {
  const { data, error } = await supabase().storage.from(BUCKET).createSignedUrl(imagePath, SIGNED_URL_TTL_SEC);
  if (error || !data) throw new Error(`createSignedUrl failed: ${error?.message}`);
  return data.signedUrl;
}
