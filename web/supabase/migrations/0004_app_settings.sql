-- 管理者が設定するアプリ全体設定（単一行）。問題生成に使うLLMは
-- クライアントからは一切変更不可にし、ここだけを正とする。
create table app_settings (
  id int primary key default 1,
  llm_provider text not null default 'openai',
  llm_model text not null default 'gpt-4o',
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);

insert into app_settings (id, llm_provider, llm_model) values (1, 'openai', 'gpt-4o');

alter table app_settings enable row level security;
