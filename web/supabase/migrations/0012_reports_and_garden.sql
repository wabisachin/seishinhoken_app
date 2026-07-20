-- 月次振り返りレポート。本人(self)・動作テスト用(test)それぞれが自分のデータを母数に
-- レポートを持つ。応援する人(guardian)は自分のプールを持たないため、self のレポートを
-- 読み取り専用で閲覧する（このテーブルに guardian 行は作らない）。
-- 1行 = 「終わった月 period_month の振り返り」＋「次の月の学習プラン」。
create table monthly_reports (
  id bigint generated always as identity primary key,
  profile text not null check (profile in ('self', 'test')),
  period_month date not null,              -- 振り返り対象の月（その月の1日、例: 2027-01-01）
  generated_at timestamptz not null default now(),
  read_at timestamptz,                      -- 所有者(self/test)が詳細を開いた時刻。未読ポップアップ判定に使う
  metrics jsonb not null,                   -- 決定的に算出した数値（解答数・新規弱点数・克服数・科目/小単元別クラスタ）
  mistake_analysis jsonb not null,          -- ステージ1 LLMの構造化出力（誤答の型分布・根本課題）
  plan jsonb not null,                      -- 決定的に算出した次月の科目別数値目標
  narrative jsonb not null,                 -- ステージ2 LLMの出力（前向きな文章・良かった点・重点説明）
  model text,
  unique (profile, period_month)            -- 冪等性: cron再実行・手動再実行でも二重生成しない
);
create index monthly_reports_profile_idx on monthly_reports (profile, period_month desc);
alter table monthly_reports enable row level security;

-- 想起の庭（克服済み問題の再出題。ユーザー向け表示名は「想起の庭」、内部modeはgarden）用の
-- 解答モードを追加する。
alter table attempts drop constraint attempts_mode_check;
alter table attempts add constraint attempts_mode_check
  check (mode in ('subject', 'mock', 'review', 'exam', 'garden'));
