/**
 * Next.jsのinstrumentation hook: サーバーインスタンスが起動する（コールドスタートする）
 * たびに1度だけ呼ばれる。新しいデプロイが本番に出た直後の最初のリクエストで確実に
 * 走るため、1日1回のCronを待たずに「デプロイ直後」の全科目ストック補充を実現できる。
 *
 * 重要: ここでは実際のネットワーク処理（Supabase等）は一切行わない。register()が
 * 動く起動直後の特殊な実行コンテキストではfetchが不安定（実際に"TypeError: fetch
 * failed"で失敗するのを確認済み）。ここではフラグを立てるだけにし、実際の処理は
 * 最初の本物のリクエストを処理するmiddleware.tsに任せる。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.VERCEL_DEPLOYMENT_ID) return; // ローカル開発時など、対象外

  const { markPendingDeployTopUp } = await import("@/lib/deployTopUp");
  markPendingDeployTopUp();
}
