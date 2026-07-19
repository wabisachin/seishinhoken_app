# -*- coding: utf-8 -*-
"""text_pdf/ の「見て覚える！国試ナビ」2冊からページ単位でテキスト候補・画像を抽出する。

養成講座テキスト(extract_textbooks.py)と違い、この教材はイラスト中心で本文の読み順が
無く、OCRテキストは「単語の袋」にしかならない。そのため生テキストをそのままRAGの
根拠チャンクにはせず、(1)ページ画像を保存してビューア表示に使う、(2)フォントサイズ上位
候補+単語群をindex_nav_pages.pyで軽量LLMに渡してタイトル・キーワードを抽出させる、
という専用パイプラインにする。

出力:
  data/nav_pages/{slug}.jsonl  各行 {book, slug, page, raw_text, title_candidates}
  data/nav_pages/{slug}/{page:04d}.jpg  ページ画像(120dpi, JPEG品質75)

要 pip: pymupdf
"""
import argparse
import io
import json
import re
import sys
import unicodedata
from pathlib import Path

import fitz  # PyMuPDF

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "text_pdf"
OUT = ROOT / "data" / "nav_pages"
OUT.mkdir(parents=True, exist_ok=True)

RENDER_DPI = 120
JPEG_QUALITY = 75
TITLE_CANDIDATE_COUNT = 12
RAW_WORD_LIMIT = 150

# 表示用書名 -> Storage/ファイル用のASCIIスラッグ（日本語・記号をキーに使うと壊れやすいため）
BOOK_SLUGS = {
    "2026 社会福祉 見て覚える！国試ナビ": "shakai",
    "2026 精神保健福祉士 見て覚える！国試ナビ": "seishin",
}

# 単独の数字列・記号のみ・仮名/漢字を含まない短い断片はOCRノイズとして除外
NOISE_RE = re.compile(r"^[\d\s.,、。ー…・\-|]+$")


def is_noise(s: str) -> bool:
    s = s.strip()
    if len(s) < 2:
        return True
    if NOISE_RE.match(s):
        return True
    if not re.search(r"[぀-ヿ一-鿿]", s):  # 仮名・漢字を含まない
        return True
    return False


def extract_page(page: "fitz.Page") -> tuple[str, list[str]]:
    raw_text = unicodedata.normalize("NFKC", page.get_text())
    d = page.get_text("dict")
    spans: list[tuple[float, str]] = []
    for block in d["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                txt = unicodedata.normalize("NFKC", span["text"].strip())
                if not txt or is_noise(txt):
                    continue
                spans.append((round(span["size"], 1), txt))
    spans.sort(key=lambda x: -x[0])
    seen = set()
    title_candidates = []
    for _, txt in spans:
        if txt in seen:
            continue
        seen.add(txt)
        title_candidates.append(txt)
        if len(title_candidates) >= TITLE_CANDIDATE_COUNT:
            break
    return raw_text, title_candidates


def raw_words(raw_text: str) -> list[str]:
    words = [w for w in re.split(r"[\s|]+", raw_text) if w and not is_noise(w)]
    return words[:RAW_WORD_LIMIT]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="各冊で処理するページ数の上限(検証用)")
    args = parser.parse_args()

    for book, slug in BOOK_SLUGS.items():
        pdf_path = SRC / f"{book}.pdf"
        if not pdf_path.exists():
            print(f"skip (not found): {pdf_path}")
            continue

        img_dir = OUT / slug
        img_dir.mkdir(parents=True, exist_ok=True)
        out_path = OUT / f"{slug}.jsonl"

        doc = fitz.open(pdf_path)
        n_pages = doc.page_count
        limit = min(args.limit, n_pages) if args.limit else n_pages
        matrix = fitz.Matrix(RENDER_DPI / 72, RENDER_DPI / 72)

        with out_path.open("w", encoding="utf-8") as f:
            for i in range(limit):
                page = doc.load_page(i)
                raw_text, title_candidates = extract_page(page)
                f.write(
                    json.dumps(
                        {
                            "book": book,
                            "slug": slug,
                            "page": i + 1,
                            "raw_text": raw_text,
                            "raw_words": raw_words(raw_text),
                            "title_candidates": title_candidates,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                pix = page.get_pixmap(matrix=matrix)
                (img_dir / f"{i + 1:04d}.jpg").write_bytes(pix.tobytes("jpg", jpg_quality=JPEG_QUALITY))
        doc.close()
        print(f"done: {book} pages={limit}/{n_pages}")


if __name__ == "__main__":
    main()
