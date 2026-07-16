-- 外部サービス（LLM課金上限・レート制限、Voyage、Supabase等）で起きたエラーを
-- 後から管理画面や開発者が振り返れるように記録する。
create table error_logs (
  id bigint generated always as identity primary key,
  source text not null,
  message text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index error_logs_created_idx on error_logs (created_at desc);

alter table error_logs enable row level security;
