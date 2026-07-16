# -*- coding: utf-8 -*-
"""出題基準PDF（テキスト層のエンコーディングが壊れているためvision抽出）→ data/taxonomy.json

各ページを画像化してOpenAI GPT-4o visionに渡し、科目→大項目→中項目→小項目の表を
構造化JSONとして抽出する。要 OPENAI_API_KEY。
（ANTHROPIC_API_KEYがあればClaudeも使える: KIJUN_PROVIDER=anthropic）

出力: [{"kind": "common"|"specialized", "subject": 科目名,
        "major": 大項目, "middle": 中項目, "minor": [小項目...]}]
"""
import base64
import io
import json
import os
import re
import sys
from pathlib import Path

import fitz
from dotenv import load_dotenv

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

PDF = ROOT / "exam_pdf" / "reference" / "精神保健福祉士_試験科目別出題基準.pdf"
OUT = ROOT / "data" / "taxonomy.json"
PROVIDER = os.environ.get("KIJUN_PROVIDER", "openai")

PROMPT = """この画像は「精神保健福祉士国家試験 試験科目別出題基準」の1ページです。
表には「大項目」「中項目」「小項目（例示）」の列があり、ページ上部やセクション見出しに科目名が書かれています。

このページの表の内容を、次のJSON配列だけで出力してください（説明文は不要）:
[
  {"subject": "科目名（このページに科目名が無く前ページの続きなら null）",
   "major": "大項目",
   "middle": "中項目（無ければ null）",
   "minor": ["小項目1", "小項目2", ...]（無ければ []）}
]

注意:
- 表の行ごとに1オブジェクト。大項目が結合セルで続いている場合は同じ大項目を繰り返す
- 出題基準の本文以外（凡例・注意書き・目次）はスキップし、該当が無いページは [] を出力
- 文字は原文どおり正確に"""


def page_png(doc: fitz.Document, pno: int) -> bytes:
    pix = doc[pno].get_pixmap(dpi=150)
    return pix.tobytes("png")


def extract_openai(b64: str) -> str:
    import urllib.request
    body = json.dumps({
        "model": "gpt-4o",
        "max_tokens": 8000,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                {"type": "text", "text": PROMPT},
            ],
        }],
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        resp = json.loads(r.read())
    return resp["choices"][0]["message"]["content"]


def extract_anthropic(b64: str) -> str:
    import anthropic
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=os.environ.get("KIJUN_MODEL", "claude-opus-4-8"),
        max_tokens=8000,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": PROMPT},
            ],
        }],
    )
    return next((b.text for b in resp.content if b.type == "text"), "[]")


def main() -> None:
    doc = fitz.open(PDF)
    rows = []
    current_subject = None
    for pno in range(doc.page_count):
        png = page_png(doc, pno)
        b64 = base64.standard_b64encode(png).decode()
        if PROVIDER == "anthropic":
            text = extract_anthropic(b64)
        else:
            text = extract_openai(b64)
        m = re.search(r"\[.*\]", text, re.S)
        page_rows = json.loads(m.group(0)) if m else []
        for r in page_rows:
            if r.get("subject"):
                current_subject = r["subject"].strip()
            r["subject"] = current_subject
            r["page"] = pno + 1
            rows.append(r)
        print(f"page {pno + 1}/{doc.page_count}: {len(page_rows)} rows (subject={current_subject})")
    doc.close()

    # 共通/専門の判定: 過去問データの科目名リストと突合
    past = ROOT / "data" / "past_questions.json"
    kind_map = {}
    if past.exists():
        for q in json.loads(past.read_text(encoding="utf-8")):
            kind_map[q["subject"]] = q["kind"]
    for r in rows:
        r["kind"] = kind_map.get(r["subject"])

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    subjects = sorted({r["subject"] for r in rows if r["subject"]})
    print(f"\nrows={len(rows)} subjects={len(subjects)} -> {OUT}")
    for s in subjects:
        print(" -", s)


if __name__ == "__main__":
    main()
