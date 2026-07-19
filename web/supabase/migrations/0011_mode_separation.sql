-- 3モード分離（本人／動作テスト用／応援する人）の第一段階。
-- questions/attempts/exam_attemptsに"どのモードのデータか"を持たせ、既存の蓄積データ
-- （デモ・動作確認データ）は全て動作テスト用(test)として引き継ぐ。本人(self)はここから
-- まっさらな状態で学習データを積み上げ直す。
--
-- 適用前に確認済み（Supabase Management API経由でSELECT実行、削除ではなく再ラベルで
-- あることを保証するため）:
--   attempts:      self=432, guardian=1（計433）
--   exam_attempts: self=1
--   questions:     634
-- guardianの1件も含め、既存の全行を無条件でtestへ再ラベルする
-- （応援する人は自分のデータプールを持たない設計のため、過去の迷い込みも含めtest扱いでよい）。

alter table questions add column profile text not null default 'self';

update questions set profile = 'test';
update attempts set profile = 'test';
update exam_attempts set profile = 'test';

-- 値の集合が固まったのでCHECK制約を追加する。attemptsのみ'guardian'を許容する
-- （safeProfileの既存ロジックが'self'|'guardian'|'test'を許容するため）。
alter table questions add constraint questions_profile_check check (profile in ('self', 'test'));
alter table attempts add constraint attempts_profile_check check (profile in ('self', 'test', 'guardian'));
alter table exam_attempts add constraint exam_attempts_profile_check check (profile in ('self', 'test'));
