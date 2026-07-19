/**
 * デプロイ直後の全科目ストック補充を「1インスタンスにつき高々1回だけ試みる」ための
 * 純粋な最適化フラグ。以前はinstrumentation.tsのregister()（コールドスタート時に
 * 1度だけ呼ばれる）で立てたフラグをmiddleware.tsが読む2段構成だったが、Vercel上では
 * register()とmiddleware.tsが同じモジュール状態（このファイルのモジュールスコープ変数）を
 * 共有しているとは限らず、実際に直近10回のデプロイで一度もクレーム（app_settings.
 * last_topup_deployment_id の更新）が成功していないことが判明した。
 *
 * そのため、middleware.ts単体で完結する方式に変更する。正しさ自体は
 * questionSupply.tsのclaimDeploymentTopUp()（app_settingsへの原子的なUPDATE）が
 * 担保しており、複数インスタンス・複数リクエストから重複して呼ばれても実害は無い
 * （最初の1回だけが実際にトップアップを実行する）。このフラグは「同じインスタンスの
 * 2回目以降のリクエストで毎回無駄なDB問い合わせを発生させない」ための軽量な間引きに過ぎない。
 */
let attemptedThisInstance = false;

export function shouldAttemptDeployTopUp(): boolean {
  if (attemptedThisInstance) return false;
  attemptedThisInstance = true;
  return true;
}
