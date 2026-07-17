# -*- coding: utf-8 -*-
"""exam_pdf/past_exam/ の試験問題PDFと正答表を突合し data/past_questions.json を作る。

出力: [{"subject": 科目名, "kind": "common"|"specialized", "number": 問題番号,
        "case_text": 事例文(事例問題のみ), "stem": 問題文, "options": [5択],
        "correct": [正答番号...]}]
"""
import io
import json
import re
import sys
import unicodedata
from pathlib import Path

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "exam_pdf" / "past_exam"
OUT = ROOT / "data"
OUT.mkdir(parents=True, exist_ok=True)


def pdf_text(path: Path) -> str:
    doc = fitz.open(path)
    text = "\n".join(doc[i].get_text("text") for i in range(doc.page_count))
    doc.close()
    return unicodedata.normalize("NFKC", text)


def parse_answer_key(answer_key_pdf: Path) -> dict:
    """正答表 → {科目名: {問題番号: [正答...]}} 行ベースの状態機械でパース。"""
    lines = [ln.strip() for ln in pdf_text(answer_key_pdf).splitlines()]
    answers = {}
    subject = None
    nums, vals = [], []
    state = "scan"  # scan -> nums -> vals
    for ln in lines:
        if not ln:
            continue
        if ln == "問題番号":
            nums, vals = [], []
            state = "nums"
            continue
        if re.fullmatch(r"正\s*答", ln):
            state = "vals"
            continue
        if state == "nums":
            if re.fullmatch(r"\d+", ln):
                nums.append(int(ln))
                continue
            state = "scan"  # 想定外 → 科目名候補として下で処理
        if state == "vals":
            if re.fullmatch(r"\d([,、]\d)*", ln):
                vals.append([int(d) for d in re.findall(r"\d", ln)])
                if len(vals) == len(nums):
                    if subject:
                        answers.setdefault(subject, {}).update(dict(zip(nums, vals)))
                    state = "scan"
                continue
            state = "scan"
        # scan: 科目名候補（数字のみ・見出し括弧・注意書きを除く）
        if state == "scan":
            if re.fullmatch(r"\d+", ln) or ln.startswith("【") or len(ln) > 40:
                continue
            if re.search(r"合格基準|合格者|注意|以上|得点|配点|試験|科目|正答|問題", ln):
                continue
            subject = ln
    return answers


CASE_RE = re.compile(r"次の事例を読んで[,、]?\s*問題\s*(\d+)\s*から\s*問題\s*(\d+)\s*までについて答えなさい。?")
# 実際の問題ヘッダは行頭の「問題 N」または「問題」改行「N」
HEADER_RE = re.compile(r"(?m)^問題\s*\n?\s*(\d+)[\s　]")


def parse_question_pdf(path: Path) -> tuple:
    """試験問題PDF → (科目名, [{number, case_text?, stem, options}])"""
    raw = pdf_text(path)
    # ページ番号だけの行を除去
    lines = [ln.rstrip() for ln in raw.splitlines()]
    lines = [ln for ln in lines if ln.strip() and not re.fullmatch(r"\d{1,3}", ln.strip())]
    subject = re.sub(r"^\d+\s*", "", lines[0]).strip()
    text = "\n".join(lines)

    # 事例ブロック: 指示文〜最初の実問題ヘッダまでを case_text として範囲の問題に付与
    cases = {}  # number -> case_text
    for m in CASE_RE.finditer(text):
        start_q, end_q = int(m.group(1)), int(m.group(2))
        after = text[m.end():]
        h = HEADER_RE.search(after)
        case_body = after[: h.start()] if h else after
        case_body = re.sub(r"^〔事\s*例〕\s*", "", case_body.strip())
        case_body = re.sub(r"\s*\n\s*", "", case_body)
        for qn in range(start_q, end_q + 1):
            cases[qn] = case_body

    headers = list(HEADER_RE.finditer(text))
    questions = []
    for i, h in enumerate(headers):
        number = int(h.group(1))
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        content = text[h.end(): end]
        # 事例指示文が混入していたら以降を落とす
        cm = CASE_RE.search(content)
        if cm:
            content = content[: cm.start()]
        opt_matches = list(re.finditer(r"(?m)^([1-5])[\s　](.+?)(?=(?:\n[1-5][\s　])|\Z)", content, re.S))
        q = {"number": number}
        if number in cases:
            q["case_text"] = cases[number]
        if len(opt_matches) >= 5:
            first_opt = opt_matches[0].start()
            q["stem"] = re.sub(r"\s*\n\s*", "", content[:first_opt]).strip()
            q["options"] = [re.sub(r"\s*\n\s*", "", o.group(2)).strip() for o in opt_matches[:5]]
        else:
            q["stem"] = re.sub(r"\s*\n\s*", "", content).strip()
            q["options"] = []
            q["parse_warning"] = True
        questions.append(q)
    return subject, questions


def main() -> None:
    # 年度ごとのサブフォルダ単位で処理し、そのフォルダ内の正答表と突き合わせる
    round_dirs = sorted(p for p in SRC.iterdir() if p.is_dir())
    if not round_dirs:
        round_dirs = [SRC]

    result = []
    for round_dir in round_dirs:
        key_pdfs = sorted(round_dir.glob("*合格基準及び正答*.pdf"))
        answers = parse_answer_key(key_pdfs[0]) if key_pdfs else {}
        print(f"\n[{round_dir.name}] answer key subjects ({len(answers)}): {'あり' if key_pdfs else 'なし(正答は空になります)'}")

        seen_names = set()
        for pdf in sorted(round_dir.glob("*.pdf")):
            if "正答" in pdf.name:
                continue
            # 同名だが "(1)" などが付いた重複ダウンロードをスキップ
            base_name = re.sub(r"\s*\(\d+\)(?=\.pdf$)", "", pdf.name)
            if base_name in seen_names:
                print(f"{pdf.name}: 重複ファイルとしてスキップ")
                continue
            seen_names.add(base_name)

            kind = "specialized" if pdf.name.startswith("se_") else "common"
            subject, questions = parse_question_pdf(pdf)
            answer_map = answers.get(subject, {})
            matched = 0
            for q in questions:
                q["subject"] = subject
                q["kind"] = kind
                q["source_file"] = f"{round_dir.name}/{pdf.name}"
                q["correct"] = answer_map.get(q["number"], [])
                if q["correct"]:
                    matched += 1
            result.extend(questions)
            warn = sum(1 for q in questions if q.get("parse_warning"))
            print(f"{pdf.name}: subject={subject} questions={len(questions)} answered={matched} warnings={warn}")

    out_path = OUT / "past_questions.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    total = len(result)
    with_ans = sum(1 for q in result if q.get("correct"))
    warns = sum(1 for q in result if q.get("parse_warning"))
    print(f"\ntotal={total} with_answers={with_ans} warnings={warns} -> {out_path}")


if __name__ == "__main__":
    main()
