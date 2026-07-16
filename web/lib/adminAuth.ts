import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";

export const ADMIN_COOKIE = "admin_session";

function expectedToken(): string {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error("ADMIN_PASSWORD が設定されていません");
  // パスワードそのものをCookieに載せず、HMACで検証可能なトークンにする。
  // ステートレス（署名鍵=ADMIN_PASSWORD自体）なのでサーバーレスの複数インスタンス間でも
  // 追加の共有ストレージ無しに検証できる。
  return createHmac("sha256", password).update("admin-session").digest("hex");
}

export function checkPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueToken(): string {
  return expectedToken();
}

export function isAdminRequest(req: NextRequest): boolean {
  const cookie = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!cookie) return false;
  try {
    const expected = expectedToken();
    const a = Buffer.from(cookie);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
