-- 精神保健福祉士 試験対策アプリ 初期スキーマ
create extension if not exists vector;

-- 教科書
create table documents (
  id bigint generated always as identity primary key,
  book text unique not null
);

create table chunks (
  id bigint generated always as identity primary key,
  document_id bigint not null references documents(id) on delete cascade,
  content text not null,
  embedding vector(1024),
  page_start int,
  page_end int
);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_document_idx on chunks (document_id);

-- 出題基準タクソノミー
create table taxonomy (
  id bigint generated always as identity primary key,
  kind text check (kind in ('common', 'specialized')),
  subject text not null,
  major text not null,
  middle text,
  minor text
);
create index taxonomy_subject_idx on taxonomy (subject);

-- 過去問（few-shot用）
create table past_questions (
  id bigint generated always as identity primary key,
  exam_round int,
  kind text,
  subject text not null,
  number int,
  case_text text,
  stem text not null,
  options jsonb not null,
  correct jsonb not null
);
create index past_questions_subject_idx on past_questions (subject);

-- 生成問題
create table questions (
  id bigint generated always as identity primary key,
  subject text not null,
  taxonomy_id bigint references taxonomy(id),
  question_type text not null default 'single' check (question_type in ('single', 'multi')),
  stem text not null,
  case_text text,
  options jsonb not null,          -- ["選択肢1", ..., "選択肢5"]
  correct jsonb not null,          -- [1] or [2,5] (1始まり)
  explanations jsonb not null,     -- ["選択肢1の解説", ..., "選択肢5の解説"]
  key_points text,                 -- 押さえるべき関連知識のまとめ
  citations jsonb,                 -- [{"chunk_id":1,"book":"...","page_start":1,"page_end":2,"excerpt":"..."}]
  status text not null default 'active' check (status in ('active', 'rejected')),
  model text,
  created_at timestamptz not null default now()
);
create index questions_subject_idx on questions (subject, status);

-- 解答記録
create table attempts (
  id bigint generated always as identity primary key,
  question_id bigint not null references questions(id) on delete cascade,
  selected jsonb not null,         -- [3] or [2,5]
  is_correct boolean not null,
  mode text not null check (mode in ('subject', 'mock', 'review')),
  answered_at timestamptz not null default now()
);
create index attempts_question_idx on attempts (question_id);
create index attempts_answered_idx on attempts (answered_at);

-- 科目別成績集計ビュー
create view subject_stats as
select
  q.subject,
  date_trunc('day', a.answered_at) as day,
  count(*)::int as attempts,
  count(*) filter (where a.is_correct)::int as correct
from attempts a
join questions q on q.id = a.question_id
group by 1, 2;

-- 類似検索RPC
create or replace function match_chunks(
  query_embedding vector(1024),
  match_count int default 8
)
returns table (
  id bigint,
  document_id bigint,
  book text,
  content text,
  page_start int,
  page_end int,
  similarity float
)
language sql stable as $$
  select c.id, c.document_id, d.book, c.content, c.page_start, c.page_end,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 個人利用: サーバー(サービスロール)からのみアクセスするため全テーブルRLS有効・ポリシー無し(=拒否)
alter table documents enable row level security;
alter table chunks enable row level security;
alter table taxonomy enable row level security;
alter table past_questions enable row level security;
alter table questions enable row level security;
alter table attempts enable row level security;
