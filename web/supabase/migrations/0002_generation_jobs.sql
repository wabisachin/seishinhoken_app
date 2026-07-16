-- バックグラウンド問題生成ジョブの状態管理（科目ごとに1行）
create table generation_jobs (
  subject text primary key,
  status text not null default 'idle' check (status in ('idle', 'running', 'stalled')),
  target_pool int not null default 5,
  consecutive_failures int not null default 0,
  last_error text,
  heartbeat_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table generation_jobs enable row level security;
