-- 実戦模試（本番同形式・時間制限つき・一度も出題していない問題だけで構成される模試）機能。
-- 問題プールの分離: 'general'=通常プール(分野別演習・ミニ模試・復習が使う)、
-- 'exam'=実戦模試専用の未消費ストック。既存問題は全てgeneralとして扱われる。
alter table questions add column pool text not null default 'general' check (pool in ('general', 'exam'));

-- 実戦模試の「回」。午前・午後は同時進行ではなく、ユーザーが選んで個別のタイミングで
-- 受けられるため、各パートの状態・出題id・開始/終了時刻をそれぞれ別カラムで持つ。
create table exam_attempts (
  id bigint generated always as identity primary key,
  profile text not null default 'self',
  common_status text not null default 'not_started' check (common_status in ('not_started', 'in_progress', 'completed')),
  specialized_status text not null default 'not_started' check (specialized_status in ('not_started', 'in_progress', 'completed')),
  common_question_ids jsonb,
  specialized_question_ids jsonb,
  common_started_at timestamptz,
  common_completed_at timestamptz,
  specialized_started_at timestamptz,
  specialized_completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index exam_attempts_profile_idx on exam_attempts (profile, created_at);
alter table exam_attempts enable row level security;

-- attempts側: 実戦模試の解答をどの回のものか紐付ける
alter table attempts drop constraint attempts_mode_check;
alter table attempts add constraint attempts_mode_check check (mode in ('subject', 'mock', 'review', 'exam'));
alter table attempts add column exam_attempt_id bigint references exam_attempts(id);

-- 成績タブ専用: 実戦模試の日次集計ビュー（既存subject_statsは全モード合算のため、
-- 成績タブはこちらに差し替える。subject_statsは他に参照箇所が無いが将来のため残す）
create view exam_subject_stats as
select
  q.subject,
  a.profile,
  date_trunc('day', a.answered_at) as day,
  count(*)::int as attempts,
  count(*) filter (where a.is_correct)::int as correct
from attempts a
join questions q on q.id = a.question_id
join exam_attempts ea on ea.id = a.exam_attempt_id
where a.mode = 'exam'
group by 1, 2, 3;
