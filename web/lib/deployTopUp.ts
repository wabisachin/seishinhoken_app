/**
 * instrumentation.tsのregister()はサーバーインスタンス起動直後の特殊な実行コンテキストで
 * 動くため、その場でSupabase等へのfetchを行うと不安定（実際に"TypeError: fetch failed"を
 * 確認済み）。そのためregister()ではこのフラグを立てるだけにし、実際のネットワーク処理は
 * 最初の本物のリクエストを処理するmiddleware.ts側（通常のリクエストコンテキストで
 * fetchが確実に使える）に任せる。
 */
let pending = false;

export function markPendingDeployTopUp(): void {
  pending = true;
}

/** trueが返るのは呼び出し後の1回だけ（同一インスタンス内で以後は常にfalse） */
export function consumePendingDeployTopUp(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}
