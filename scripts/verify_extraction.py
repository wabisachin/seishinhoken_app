# -*- coding: utf-8 -*-
"""抽出品質のサンプル検証。

教科書1冊・出題基準・過去問・正答表からサンプルページを抽出し、
テキスト層の有無と品質を確認する。結果は data/verify/ に保存。
"""
import io
import json
import sys
from pathlib import Path

import fitz  # PyMuPDF

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "verify"
OUT.mkdir(parents=True, exist_ok=True)

TARGETS = [
    ("textbook", ROOT / "text_pdf" / "最新 精神保健福祉士養成講座 1.pdf", [30, 60, 120]),
    ("kijun", ROOT / "exam_pdf" / "reference" / "精神保健福祉士_試験科目別出題基準.pdf", [1, 3, 5]),
    ("past_exam_se", ROOT / "exam_pdf" / "past_exam" / "se_pm_01_28.pdf", [0, 1, 2]),
    ("past_exam_sp", ROOT / "exam_pdf" / "past_exam" / "sp_am_01_38.pdf", [0, 1, 2]),
    ("answer_key", ROOT / "exam_pdf" / "past_exam" / "第２８回精神保健福祉士国家試験の合格基準及び正答について.pdf", [0, 1, 2]),
]

summary = []
for label, path, pages in TARGETS:
    if not path.exists():
        summary.append({"label": label, "error": f"not found: {path}"})
        continue
    doc = fitz.open(path)
    info = {"label": label, "file": path.name, "page_count": doc.page_count, "samples": []}
    for pno in pages:
        if pno >= doc.page_count:
            continue
        page = doc[pno]
        text = page.get_text("text")
        info["samples"].append({
            "page": pno + 1,
            "chars": len(text),
            "preview": text[:400],
        })
        (OUT / f"{label}_p{pno + 1}.txt").write_text(text, encoding="utf-8")
    # 全ページの文字数分布を軽く見る
    counts = [len(doc[i].get_text("text")) for i in range(0, doc.page_count, max(1, doc.page_count // 20))]
    info["char_count_samples"] = counts
    summary.append(info)
    doc.close()

(OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

for s in summary:
    if "error" in s:
        print(f"[{s['label']}] ERROR: {s['error']}")
        continue
    print(f"[{s['label']}] {s['file']} pages={s['page_count']} char_dist={s['char_count_samples']}")
    for smp in s["samples"]:
        head = smp["preview"].replace("\n", " ")[:120]
        print(f"  p{smp['page']}: {smp['chars']} chars | {head}")
