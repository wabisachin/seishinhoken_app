-- 過去問(past_questions)は正答表しか持たず解説が無いため、AI生成問題(questions)と同じ形の
-- 解説カラムを追加する。過去問をキャリブレーション用に演習・模試へ混入した際、ユーザーには
-- AI生成問題と見分けがつかない形で解説を表示する必要があるため。
alter table past_questions add column explanations jsonb;
alter table past_questions add column key_points text;
alter table past_questions add column citation_chunk_ids jsonb;
alter table past_questions add column option_citations jsonb;
alter table past_questions add column explained_at timestamptz;
