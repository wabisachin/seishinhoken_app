/**
 * Next.jsのinstrumentation hook: サーバーインスタンスが起動する（コールドスタートする）
 * たびに1度だけ呼ばれる。新しいデプロイが本番に出た直後の最初のリクエストで確実に
 * 走るため、1日1回のCronを待たずに「デプロイ直後」の全科目ストック補充を実現できる。
 *
 * 実行はデプロイごとに1回だけにする（claimDeploymentTopUp、app_settingsのマーカー列で
 * 判定）。Vercelの負荷分散で複数インスタンスが同時にコールドスタートしても、DBの
 * 条件付き更新に勝った1インスタンスだけが実際に補充を行う。
 *
 * ここでの処理は register() の戻りを待たせず（awaitしない）バックグラウンドで実行する。
 * awaitすると、このインスタンスがどのリクエストも処理できるようになるまで最大で
 * 内部の時間予算ぶん（数分）待たされてしまうため。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  if (!deploymentId) return; // ローカル開発時など、対象外

  const { claimDeploymentTopUp, topUpAllSubjects } = await import("@/lib/questionSupply");
  const { logError } = await import("@/lib/errorLog");

  void (async () => {
    try {
      const claimed = await claimDeploymentTopUp(deploymentId);
      if (!claimed) return;
      await topUpAllSubjects();
    } catch (e) {
      await logError("instrumentation-topup", e, { deploymentId });
    }
  })();
}
