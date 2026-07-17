-- 新しいデプロイのコールドスタート直後に、全科目のストックを1回だけ自動補充するための
-- マーカー（instrumentation.ts参照）。デプロイごとに1回だけ実行させ、同一デプロイの
-- 複数インスタンスが同時にコールドスタートしても重複実行しないようにする。
alter table app_settings add column last_topup_deployment_id text;
