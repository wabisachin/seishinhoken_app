-- 0013で追加したcitation_chunk_ids/option_citationsはLLM出力の生データ用の列だったが、
-- questionsテーブルには存在せず、実際に表示・再利用されるのはgeneration.tsが計算する
-- 最終形のcitations（chunk_id/book/page_start/page_end/excerpt/supports/quotes）のみ。
-- past_questionsもquestionsとそろえ、citationsだけを持つ形にする。
alter table past_questions drop column citation_chunk_ids;
alter table past_questions drop column option_citations;
alter table past_questions add column citations jsonb;
