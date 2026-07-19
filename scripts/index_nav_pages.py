# -*- coding: utf-8 -*-
"""extract_nav_pages.pyの出力(data/nav_pages/*.jsonl + ページ画像)を
  1. 軽量LLM(OpenAI gpt-4o-mini)でタイトル・キーワード抽出(OCRノイズのクリーニング)
  2. クリーニング後のtitle+keywordsをVoyageで埋め込み
  3. ページ画像をSupabase Storage(nav-pages, private)にアップロード
  4. nav_pagesテーブルにupsert
する。

chunks/documentsとは完全に別パイプライン・別テーブル。生成(問題作成)のRAG根拠プールには
一切混入しない。生テキスト(raw_words)は埋め込みには使わない(クリーニングで除去した
OCRノイズを検索ベクトルに再混入させないため)。DBのraw_textカラムにはデバッグ用に保存する。

要 .env: OPENAI_API_KEY, VOYAGE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
import argparse
import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from tqdm import tqdm

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

import openai  # noqa: E402
import voyageai  # noqa: E402
from voyageai.error import RateLimitError  # noqa: E402
from supabase import create_client  # noqa: E402
from storage3.types import CreateOrUpdateBucketOptions  # noqa: E402

NAV_DIR = ROOT / "data" / "nav_pages"
CLEAN_MODEL = "gpt-4o-mini"
EMBED_MODEL = "voyage-4"
BUCKET = "nav-pages"
EMBED_BATCH = 64
RATE_LIMIT_BACKOFF_SEC = 30
RATE_LIMIT_MAX_RETRIES = 10
CLEAN_WORKERS = 8


def clean_prompt(row: dict) -> str:
    return f"""以下は精神保健福祉士国家試験対策の図解教材（国試ナビ）のあるページをOCRで読み取った断片情報です。
レイアウトが複雑なため、テキストの読み順は保証されておらず、図表中の数値やノイズも混ざっています。

フォントサイズが大きい順の候補（見出しである可能性が高い）:
{json.dumps(row["title_candidates"], ensure_ascii=False)}

ページ全体から拾った単語群（順不同、ノイズ含む）:
{json.dumps(row["raw_words"], ensure_ascii=False)}

このページの内容を検索で見つけられるようにしたいです。以下をJSON形式で出力してください。
- title: このページの見出し・タイトル（15字程度、判断できなければ空文字）
- keywords: このページで扱われている専門用語・制度名・法律名など、検索に使えるキーワードを5〜15個

数値のみの断片、意味をなさない記号列、図表の軸ラベルのような断片はノイズとして無視してください。
JSONのみを出力してください。"""


def clean_one(client: "openai.OpenAI", row: dict) -> dict:
    resp = client.chat.completions.create(
        model=CLEAN_MODEL,
        max_tokens=500,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": clean_prompt(row)}],
    )
    cleaned = json.loads(resp.choices[0].message.content.strip())
    title = (cleaned.get("title") or "").strip()
    keywords = [k for k in (cleaned.get("keywords") or []) if isinstance(k, str) and k.strip()]
    content = (title + " " + " ".join(keywords)).strip() or row["page_number_fallback"]
    return {**row, "title": title, "content": content}


def embed_with_backoff(vo: "voyageai.Client", batch: list, model: str):
    for attempt in range(RATE_LIMIT_MAX_RETRIES):
        try:
            return vo.embed(batch, model=model, input_type="document")
        except RateLimitError:
            if attempt == RATE_LIMIT_MAX_RETRIES - 1:
                raise
            print(f"  rate limited, waiting {RATE_LIMIT_BACKOFF_SEC}s (attempt {attempt + 1})")
            time.sleep(RATE_LIMIT_BACKOFF_SEC)


def ensure_bucket(sb) -> None:
    existing = {b.id for b in sb.storage.list_buckets()}
    if BUCKET in existing:
        return
    sb.storage.create_bucket(BUCKET, options=CreateOrUpdateBucketOptions(public=False))
    print(f"created storage bucket: {BUCKET}")


def upload_with_retry(sb, storage_path: str, data: bytes, attempts: int = 5) -> None:
    for attempt in range(attempts):
        try:
            sb.storage.from_(BUCKET).upload(
                storage_path, data, file_options={"content-type": "image/jpeg", "upsert": "true"}
            )
            return
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(5 * (attempt + 1))  # Storage側の一時的な503対策


def reupload_images_only(sb) -> None:
    """タイトル抽出・埋め込みはそのままに、ページ画像だけ再アップロードする
    （画像パスは変わらないため、DB(nav_pages.image_path)の更新は不要。x-upsertで上書き）。"""
    for slug_dir in sorted(p for p in NAV_DIR.iterdir() if p.is_dir()):
        slug = slug_dir.name
        images = sorted(slug_dir.glob("*.jpg"))
        for img_path in tqdm(images, desc=f"reupload {slug}"):
            storage_path = f"{slug}/{img_path.name}"
            upload_with_retry(sb, storage_path, img_path.read_bytes())
        print(f"done: {slug} ({len(images)} images reuploaded)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="各冊で処理するページ数の上限(検証用)")
    parser.add_argument(
        "--images-only",
        action="store_true",
        help="タイトル抽出・埋め込みをやり直さず、画像だけ再アップロードする(解像度変更時など)",
    )
    args = parser.parse_args()

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    ensure_bucket(sb)

    if args.images_only:
        reupload_images_only(sb)
        return

    oa = openai.OpenAI()
    vo = voyageai.Client()

    for jsonl in sorted(NAV_DIR.glob("*.jsonl")):
        slug = jsonl.stem
        rows = [json.loads(ln) for ln in jsonl.read_text(encoding="utf-8").splitlines()]
        if args.limit:
            rows = rows[: args.limit]
        for r in rows:
            r["page_number_fallback"] = f"{r['book']} p{r['page']}"

        # --- クリーニング (OpenAI, 並列) ---
        cleaned_rows = [None] * len(rows)
        with ThreadPoolExecutor(max_workers=CLEAN_WORKERS) as ex:
            futures = {ex.submit(clean_one, oa, r): i for i, r in enumerate(rows)}
            for fut in tqdm(as_completed(futures), total=len(futures), desc=f"clean {slug}"):
                i = futures[fut]
                cleaned_rows[i] = fut.result()

        # --- 埋め込み (Voyage, バッチ) ---
        for i in tqdm(range(0, len(cleaned_rows), EMBED_BATCH), desc=f"embed {slug}"):
            batch = cleaned_rows[i : i + EMBED_BATCH]
            res = embed_with_backoff(vo, [r["content"] for r in batch], EMBED_MODEL)
            for r, emb in zip(batch, res.embeddings):
                r["embedding"] = emb

        # --- 画像アップロード + DB upsert ---
        for r in tqdm(cleaned_rows, desc=f"upload+insert {slug}"):
            img_path = NAV_DIR / slug / f"{r['page']:04d}.jpg"
            storage_path = f"{slug}/{r['page']:04d}.jpg"
            sb.storage.from_(BUCKET).upload(
                storage_path,
                img_path.read_bytes(),
                file_options={"content-type": "image/jpeg", "upsert": "true"},
            )
            sb.table("nav_pages").upsert(
                {
                    "book": r["book"],
                    "page_number": r["page"],
                    "title": r["title"],
                    "content": r["content"],
                    "raw_text": r["raw_text"],
                    "embedding": r["embedding"],
                    "image_path": storage_path,
                },
                on_conflict="book,page_number",
            ).execute()

        print(f"done: {slug} ({len(cleaned_rows)} pages)")

    total = sb.table("nav_pages").select("id", count="exact").limit(1).execute()
    print(f"\ndone. total nav_pages in DB: {total.count}")


if __name__ == "__main__":
    main()
