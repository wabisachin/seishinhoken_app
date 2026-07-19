-- 国試ナビ(図解教材)のページ単位インデックス。chunks/documentsとは完全に別テーブル
-- （問題生成のRAG根拠プールに、OCRノイズを含みうる図解ページの断片テキストを混入させないため）。
-- 表示専用: 教科書検索バナーと解説画面の関連ページビューアからのみ参照する。
create table nav_pages (
  id bigint generated always as identity primary key,
  book text not null,           -- 表示用の書籍名（例: "2026 社会福祉 見て覚える！国試ナビ"）
  page_number int not null,
  title text,
  content text not null,        -- クリーニング後のtitle+keywords。embeddingの元でありAPIレスポンスにも使う
  raw_text text,                -- OCR生テキスト（デバッグ・将来の再クリーニング用。embeddingには使わない）
  embedding vector(1024),
  image_path text not null,     -- Storage(nav-pagesバケット)のオブジェクトパス。ASCIIスラッグ（例: "shakai/0022.jpg"）
  created_at timestamptz not null default now(),
  unique (book, page_number)
);
create index nav_pages_embedding_idx on nav_pages using hnsw (embedding vector_cosine_ops);

create or replace function match_nav_pages(
  query_embedding vector(1024),
  match_count int default 5
)
returns table (
  id bigint,
  book text,
  page_number int,
  title text,
  image_path text,
  similarity float
)
language sql stable as $$
  select id, book, page_number, title, image_path,
         1 - (embedding <=> query_embedding) as similarity
  from nav_pages
  order by embedding <=> query_embedding
  limit match_count;
$$;

alter table nav_pages enable row level security; -- 既存テーブルと同じ「ポリシー無し=サービスロールのみ」方針

-- 解説画面用: 問題ごとに一致した国試ナビページをキャッシュ（毎回embedding検索しないため）。
-- nav_page_checkedを分けるのは、「検索したが十分に近いページが無かった」場合も再検索を
-- 避けたいため（nav_page_id is nullだけだと「未チェック」と「該当なし」を区別できない）。
alter table questions add column nav_page_id bigint references nav_pages(id);
alter table questions add column nav_page_checked boolean not null default false;
