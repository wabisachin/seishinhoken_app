# -*- coding: utf-8 -*-
"""text_pdf/ の教科書24冊からページ単位でテキスト抽出し data/textbooks/*.jsonl に保存する。

各行: {"book": 書名, "page": ページ番号(1始まり), "text": 整形済みテキスト}
"""
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
OUT = ROOT / "data" / "textbooks"
OUT.mkdir(parents=True, exist_ok=True)


def clean_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    lines = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # ページ番号だけの行を除去
        if re.fullmatch(r"[0-9]{1,4}", line):
            continue
        lines.append(line)
    return "\n".join(lines)


def main() -> None:
    # 「見て覚える！国試ナビ」はイラスト中心の図解教材で、ページ本文をそのままテキスト
    # チャンクとして問題生成の根拠に使うと精度が下がる。専用パイプライン
    # (extract_nav_pages.py / index_nav_pages.py、nav_pagesテーブル)で別途扱うため、
    # ここでは除外して chunks/documents に混入しないようにする
    pdfs = sorted(p for p in SRC.glob("*.pdf") if "国試ナビ" not in p.stem)
    if not pdfs:
        print(f"no PDFs found in {SRC}")
        return
    for pdf in pdfs:
        book = pdf.stem
        out_path = OUT / f"{book}.jsonl"
        if out_path.exists():
            print(f"skip (exists): {book}")
            continue
        doc = fitz.open(pdf)
        n_pages = doc.page_count
        n_chars = 0
        tmp_path = out_path.with_suffix(".jsonl.tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            for i in range(n_pages):
                text = clean_text(doc[i].get_text("text"))
                n_chars += len(text)
                if len(text) < 30:  # 表紙・白紙・図のみのページはスキップ
                    continue
                f.write(json.dumps({"book": book, "page": i + 1, "text": text}, ensure_ascii=False) + "\n")
        doc.close()
        tmp_path.replace(out_path)
        print(f"done: {book} pages={n_pages} chars={n_chars}")


if __name__ == "__main__":
    main()
