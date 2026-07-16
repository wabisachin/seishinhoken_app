-- 問題生成に伴うLLM呼び出し（HyDE検索クエリ生成・問題生成・自己検証）のトークン使用量を
-- 記録し、管理画面で累積の利用量・推定コストを確認できるようにする。
create table llm_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  source text not null, -- 'hyde' | 'generate' | 'verify'
  subject text,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0
);
create index llm_usage_created_idx on llm_usage (created_at desc);
create index llm_usage_model_idx on llm_usage (provider, model);

alter table llm_usage enable row level security;
