# -*- coding: utf-8 -*-
"""教科書テキストをチャンク分割 → Voyage埋め込み → Supabase投入。
taxonomy.json / past_questions.json があればそれらも投入する。

要 .env: VOYAGE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
import io
import json
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from tqdm import tqdm

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

import voyageai  # noqa: E402
from voyageai.error import RateLimitError  # noqa: E402
from supabase import create_client  # noqa: E402


def embed_with_backoff(vo: "voyageai.Client", batch: list, model: str):
    for attempt in range(RATE_LIMIT_MAX_RETRIES):
        try:
            return vo.embed(batch, model=model, input_type="document")
        except RateLimitError:
            if attempt == RATE_LIMIT_MAX_RETRIES - 1:
                raise
            print(f"  rate limited, waiting {RATE_LIMIT_BACKOFF_SEC}s (attempt {attempt + 1})")
            time.sleep(RATE_LIMIT_BACKOFF_SEC)

DATA = ROOT / "data"
CHUNK_TARGET = 800   # 文字
CHUNK_OVERLAP = 120  # 文字
# voyage-3.5は無料枠(200M)を使い切り済みのアカウントのため、
# 無料枠が残っているvoyage-4を使う(デフォルト1024次元でスキーマ互換)
EMBED_MODEL = "voyage-4"
EMBED_BATCH = 64
INSERT_BATCH = 200
RATE_LIMIT_BACKOFF_SEC = 30
RATE_LIMIT_MAX_RETRIES = 10


def sentences(text: str):
    """「。」で文分割（改行も区切りとして残す）"""
    return [s for s in re.split(r"(?<=。)|\n", text) if s.strip()]


def chunk_book(pages: list) -> list:
    """ページ列 → [{content, page_start, page_end}] 文境界を尊重した約800字チャンク"""
    chunks = []
    buf = []       # [(sentence, page)]
    buf_len = 0

    def flush():
        nonlocal buf, buf_len
        if not buf:
            return
        content = "".join(s for s, _ in buf).strip()
        if len(content) >= 100:
            chunks.append({
                "content": content,
                "page_start": buf[0][1],
                "page_end": buf[-1][1],
            })
        # オーバーラップ: 末尾からCHUNK_OVERLAP文字ぶんの文を残す
        keep, keep_len = [], 0
        for s, p in reversed(buf):
            keep.insert(0, (s, p))
            keep_len += len(s)
            if keep_len >= CHUNK_OVERLAP:
                break
        buf = keep
        buf_len = keep_len

    for page in pages:
        for s in sentences(page["text"]):
            buf.append((s, page["page"]))
            buf_len += len(s)
            if buf_len >= CHUNK_TARGET:
                flush()
    # 最後のフラッシュ（オーバーラップ分だけ残っている場合は捨てる）
    if buf_len > CHUNK_OVERLAP + 50:
        content = "".join(s for s, _ in buf).strip()
        if len(content) >= 100:
            chunks.append({"content": content, "page_start": buf[0][1], "page_end": buf[-1][1]})
    return chunks


def main() -> None:
    vo = voyageai.Client()
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    # --- taxonomy ---
    tax_path = DATA / "taxonomy.json"
    if tax_path.exists():
        existing = sb.table("taxonomy").select("id", count="exact").limit(1).execute()
        if (existing.count or 0) == 0:
            rows = json.loads(tax_path.read_text(encoding="utf-8"))
            payload = [{
                "kind": r.get("kind"),
                "subject": r.get("subject"),
                "major": r.get("major"),
                "middle": r.get("middle"),
                "minor": "、".join(r.get("minor") or []) or None,
            } for r in rows if r.get("subject") and r.get("major")]
            for i in range(0, len(payload), INSERT_BATCH):
                sb.table("taxonomy").insert(payload[i:i + INSERT_BATCH]).execute()
            print(f"taxonomy: inserted {len(payload)} rows")
        else:
            print("taxonomy: already seeded, skip")

    # --- past_questions ---
    pq_path = DATA / "past_questions.json"
    if pq_path.exists():
        existing = sb.table("past_questions").select("id", count="exact").limit(1).execute()
        if (existing.count or 0) == 0:
            rows = json.loads(pq_path.read_text(encoding="utf-8"))
            payload = [{
                "exam_round": 28,
                "kind": q["kind"],
                "subject": q["subject"],
                "number": q["number"],
                "case_text": q.get("case_text"),
                "stem": q["stem"],
                "options": q["options"],
                "correct": q["correct"],
            } for q in rows if q.get("options") and q.get("correct")]
            for i in range(0, len(payload), INSERT_BATCH):
                sb.table("past_questions").insert(payload[i:i + INSERT_BATCH]).execute()
            print(f"past_questions: inserted {len(payload)} rows")
        else:
            print("past_questions: already seeded, skip")

    # --- textbooks: chunk + embed ---
    for jsonl in sorted((DATA / "textbooks").glob("*.jsonl")):
        book = jsonl.stem
        # documents upsert
        doc_res = sb.table("documents").upsert({"book": book}, on_conflict="book").execute()
        doc_id = doc_res.data[0]["id"]

        pages = [json.loads(ln) for ln in jsonl.read_text(encoding="utf-8").splitlines()]
        chunks = chunk_book(pages)

        existing = sb.table("chunks").select("id", count="exact").eq("document_id", doc_id).limit(1).execute()
        existing_count = existing.count or 0
        if existing_count >= len(chunks):
            print(f"skip (already embedded): {book}")
            continue
        if existing_count > 0:
            # 前回中断で一部だけ投入済み → チャンク分割は決定的なので消して撮り直す
            sb.table("chunks").delete().eq("document_id", doc_id).execute()
            print(f"{book}: found partial {existing_count} chunks, re-embedding from scratch")

        print(f"{book}: {len(pages)} pages -> {len(chunks)} chunks")

        inserted = 0
        for i in tqdm(range(0, len(chunks), EMBED_BATCH), desc=f"embed {book[:20]}"):
            batch_chunks = chunks[i:i + EMBED_BATCH]
            res = embed_with_backoff(vo, [c["content"] for c in batch_chunks], EMBED_MODEL)
            payload = [{
                "document_id": doc_id,
                "content": c["content"],
                "embedding": emb,
                "page_start": c["page_start"],
                "page_end": c["page_end"],
            } for c, emb in zip(batch_chunks, res.embeddings)]
            sb.table("chunks").insert(payload).execute()
            inserted += len(payload)
        print(f"inserted {inserted} chunks for {book}")

    total = sb.table("chunks").select("id", count="exact").limit(1).execute()
    print(f"\ndone. total chunks in DB: {total.count}")


if __name__ == "__main__":
    main()
