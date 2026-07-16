-- リリース初期は本人・応援する人（家族やテスター）が同じアプリを同時に触る可能性があるため、
-- 誰の解答かをprofileで区別できるようにする（ログイン機能ではなく、ブラウザの
-- localStorageに保存された自己申告の区分。'self'=本人のみ成績・復習対象に含める）。
alter table attempts add column profile text not null default 'self';

drop view if exists subject_stats;
create view subject_stats as
select
  q.subject,
  a.profile,
  date_trunc('day', a.answered_at) as day,
  count(*)::int as attempts,
  count(*) filter (where a.is_correct)::int as correct
from attempts a
join questions q on q.id = a.question_id
group by 1, 2, 3;
