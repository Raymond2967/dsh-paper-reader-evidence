"""Build a page/line evidence index for a PDF.

Text-layer geometry comes from PyMuPDF; raster-only labels come from Windows
OCR (`windows-ocr.ps1`).  The output is deliberately a plain JSON file: the
Host only needs stable evidence ids, page numbers, text and normalized boxes.

This helper is optional.  When Python/PyMuPDF/Windows OCR is unavailable the
plugin still serves the reader, transcript and keyword search, but evidence
lookup reports the missing prerequisite instead of inventing coordinates.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import math
import re
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymupdf  # type: ignore
except Exception:  # pragma: no cover - exercised only on machines without PyMuPDF
    print(json.dumps({
        "ok": False,
        "error": "证据索引需要 Python 包 PyMuPDF（pip install pymupdf）",
    }, ensure_ascii=False))
    raise SystemExit(2)

CJK = r"\u3400-\u9fff\uf900-\ufaff"
PUNCT_RE = re.compile(r"[\s\u00ad\-_/\\.,，。、:：;；!?！？'\"“”‘’()（）\[\]【】{}<>《》〈〉|·•]+")
OCR_EDGE_RE = re.compile(r"^[^0-9A-Za-z\u3400-\u9fff]+|[^0-9A-Za-z\u3400-\u9fff]+$")


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "").casefold()
    return PUNCT_RE.sub("", value)


def round_box(box, width: float, height: float):
    x0, y0, x1, y1 = box
    return [
        round(max(0.0, min(1.0, x0 / width)), 5),
        round(max(0.0, min(1.0, y0 / height)), 5),
        round(max(0.0, min(1.0, x1 / width)), 5),
        round(max(0.0, min(1.0, y1 / height)), 5),
    ]


def union(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return [0.0, 0.0, 0.0, 0.0]
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def overlap_ratio(a, b) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    area = max(1e-9, (a[2] - a[0]) * (a[3] - a[1]))
    return inter / area


def clean_workshop_text(text: str, words):
    """Drop OCR junk before a workshop name and return (text, first_word).

    Page 2 of the acceptance brochure yields lines such as
    ``《 目 ， 大 型 机 械 加 工 工 坊 E2101``.  The label starts at the last
    CJK run before ``工坊``; using the word boxes keeps the returned rectangle
    on the label instead of on the decorative edge marks.
    """
    compact = "".join(w["text"] for w in words)
    at = compact.find("工坊")
    if at <= 0:
        return compact, 0
    start = 0
    # OCR often leaves decorative marks and a stray heading glyph before the
    # label.  Strip leading punctuation, then a single isolated CJK glyph plus
    # its punctuation ("《目，大型…" -> "大型…").  Multi-character names such
    # as "木工模型与3D打印工坊" stay intact.
    cleaned = re.sub(r"^[^0-9A-Za-z\u3400-\u9fff]+", "", compact)
    single = re.match(rf"^([{CJK}])[，,、.．:：]+", cleaned)
    if single:
        cleaned = cleaned[single.end():]
    start = compact.find(cleaned) if cleaned else 0
    if start < 0:
        start = 0
    # Convert a character offset into the owning OCR word.
    pos = 0
    first_word = 0
    for index, word in enumerate(words):
        nxt = pos + len(word["text"])
        if start < nxt:
            first_word = index
            break
        pos = nxt
    return compact[start:], first_word


def px_box(word):
    x0, y0, x1, y1 = word["box"]
    return [float(x0), float(y0), float(x1), float(y1)]


def text_lines(page, page_number: int, doc_id: str):
    data = page.get_text("rawdict", flags=pymupdf.TEXTFLAGS_TEXT)
    width, height = page.rect.width, page.rect.height
    records = []
    line_no = 0
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            line_no += 1
            chars = []
            pieces = []
            for span in line.get("spans", []):
                for char in span.get("chars", []):
                    c = char.get("c", "")
                    # Some embedded fonts map digits to private-use codepoints
                    # (e.g. W\uf6b2-\uf6b7F).  Those glyphs have no readable
                    # Unicode text and render as replacement boxes in the UI.
                    # Drop them; the OCR line still supplies the label, and the
                    # remaining text stays honest about incomplete room codes.
                    if c == "" or c == "\ufffd" or 0xF000 <= ord(c) <= 0xF8FF:
                        continue
                    chars.append({"c": c, "b": round_box(char["bbox"], width, height)})
                    pieces.append(c)
            text = "".join(pieces)
            if not norm(text):
                continue
            # PyMuPDF's rawdict occasionally omits whitespace characters; the
            # line bbox remains a valid fallback for exact text queries.
            if not chars:
                chars = [{"c": ch, "b": round_box(line["bbox"], width, height)} for ch in text]
            records.append({
                "id": f"{doc_id}:p{page_number}:t{line_no}",
                "page": page_number,
                "text": text,
                "bbox": round_box(line["bbox"], width, height),
                "chars": chars,
                "source": "text",
            })
    return records


def ocr_page(pdf_path: Path, page, page_number: int, doc_id: str, work_dir: Path, max_dim: int, ps1: Path):
    scale = max_dim / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    image = work_dir / f"page-{page_number}.png"
    pix.save(str(image))
    proc = subprocess.run(
        [
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(ps1), str(image),
        ],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=90,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "Windows OCR failed").strip()[:500])
    raw = (proc.stdout or "").lstrip("\ufeff").strip()
    if not raw:
        return []
    lines = json.loads(raw)
    width, height = pix.width, pix.height
    records = []
    for line in lines:
        words = [w for w in line.get("words", []) if w.get("text")]
        if not words:
            continue
        text, first_word = clean_workshop_text(line.get("text") or "", words)
        text = OCR_EDGE_RE.sub("", text)
        if not text or not norm(text):
            continue
        keep = words[first_word:]
        boxes = [px_box(w) for w in keep]
        bbox = union(boxes)
        chars = []
        for word in keep:
            for ch in word["text"]:
                chars.append({"c": ch, "b": round_box(px_box(word), width, height)})
        records.append({
            "id": f"{doc_id}:p{page_number}:o{len(records) + 1}",
            "page": page_number,
            "text": text,
            "bbox": round_box(bbox, width, height),
            "chars": chars,
            "source": "ocr",
        })
    return records


def dedupe_ocr(text_records, ocr_records):
    kept = []
    for record in ocr_records:
        duplicate = False
        a = record["bbox"]
        na = norm(record["text"])
        for other in text_records:
            if other["page"] != record["page"]:
                continue
            if overlap_ratio(a, other["bbox"]) < 0.35:
                continue
            ratio = difflib.SequenceMatcher(None, na, norm(other["text"])).ratio()
            if ratio >= 0.45:
                duplicate = True
                break
        if not duplicate:
            kept.append(record)
    return kept


def _block_text(block):
    return " ".join(str(block[4] if len(block) > 4 else "").split())


def _caption_for(captions, prefix, table_bbox, page_width):
    """Find the caption that belongs to a table/figure near the detected box."""
    above = []
    below = []
    for block in captions:
        text = _block_text(block)
        if not re.match(rf"^{prefix}\s*\d+\s*[:.]", text, re.I):
            continue
        x0, y0, x1, y1 = block[:4]
        # Captions sit immediately above or below the object, in the same column.
        if x1 < table_bbox[0] - 40 or x0 > table_bbox[2] + 40:
            continue
        if y1 <= table_bbox[1] + 4:
            above.append((table_bbox[1] - y1, block))
        elif y0 >= table_bbox[3] - 4:
            below.append((y0 - table_bbox[3], block))
    # Table captions in this corpus are above the grid.  Preferring above is
    # essential on dense pages: Table 6's caption (above) was closer to the
    # next table's Table 7 caption (below), which used to mislabel Table 6.
    candidates = above or below
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])[1]


def layout_blocks(page, page_number: int, doc_id: str):
    """Add whole-table and whole-figure evidence, separate from text lines.

    Text lines remain useful for exact cells, but a reader discussing a table
    needs the table header and all rows in one box.  PyMuPDF's table detector
    supplies the ruled-table box; figures are reconstructed from the caption,
    vector drawings/images, and nearby axis labels in the same column.
    """
    width, height = page.rect.width, page.rect.height
    blocks = page.get_text("blocks")
    captions = [b for b in blocks if re.match(r"^(Table|Figure|Fig\.)\s*\d+\s*[:.]", _block_text(b), re.I)]
    records = []

    # Whole tables.  Keep one record even when the detector finds nested boxes.
    try:
        tables = page.find_tables().tables
    except Exception:
        tables = []
    table_boxes = []
    for index, table in enumerate(tables, start=1):
        box = [float(v) for v in table.bbox]
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        # Nested/duplicate detections: keep only the outermost box.
        if any(box[0] >= other[0] and box[1] >= other[1] and box[2] <= other[2] and box[3] <= other[3] for other in table_boxes):
            continue
        table_boxes.append(box)
        caption = _caption_for(captions, "Table", box, width)
        label = "Table"
        table_key = f"table{index}"
        text_parts = []
        if caption is not None:
            label = re.match(r"^(Table\s*\d+)", _block_text(caption), re.I).group(1)
            number = re.search(r"\d+", label)
            if number:
                table_key = f"table{number.group(0)}"
            text_parts.append(_block_text(caption))
        try:
            for row in table.extract():
                cells = [" ".join((cell or "").split()) for cell in row]
                if any(cells):
                    text_parts.append("\t".join(cells))
        except Exception:
            pass
        if not text_parts:
            text_parts.append(f"Table {index}")
        full = box[:]
        if caption is not None:
            full = [
                min(full[0], caption[0]), min(full[1], caption[1]),
                max(full[2], caption[2]), max(full[3], caption[3]),
            ]
        records.append({
            "id": f"{doc_id}:p{page_number}:{table_key}",
            "page": page_number,
            "text": "\n".join(text_parts),
            "bbox": round_box(full, width, height),
            "chars": [],
            "source": "layout",
            "kind": "table",
            "label": label,
        })

    # Whole figures.  A caption is the anchor; drawings/images and labels above
    # it in the same column form the visual region.
    drawings = []
    try:
        drawings = [d["rect"] for d in page.get_drawings()]
    except Exception:
        pass
    images = []
    try:
        images = [pymupdf.Rect(info["bbox"]) for info in page.get_image_info()]
    except Exception:
        pass
    for caption in captions:
        text = _block_text(caption)
        match = re.match(r"^(Figure|Fig\.)\s*(\d+)", text, re.I)
        if not match:
            continue
        label = f"Figure {match.group(2)}"
        cap = [float(v) for v in caption[:4]]
        column_left, column_right = (0.0, width / 2.0) if (cap[0] + cap[2]) / 2 < width / 2 else (width / 2.0, width)
        above = [
            [float(r.x0), float(r.y0), float(r.x1), float(r.y1)]
            for r in drawings + images
            if r.width > 2 and r.height > 2
            and r.x0 >= column_left - 12 and r.x1 <= column_right + 12
            and r.y1 <= cap[1] + 4 and r.y0 >= cap[1] - 500
        ]
        if not above:
            continue
        top = min(r[1] for r in above)
        nearby_text = []
        for block in blocks:
            if block is caption:
                continue
            b = [float(v) for v in block[:4]]
            if b[0] < column_left - 12 or b[2] > column_right + 12:
                continue
            if b[1] >= top - 8 and b[3] <= cap[1] + 4:
                nearby_text.append(b)
        full = [min([cap[0], *[r[0] for r in above], *[b[0] for b in nearby_text]]),
                min([cap[1], *[r[1] for r in above], *[b[1] for b in nearby_text]]),
                max([cap[2], *[r[2] for r in above], *[b[2] for b in nearby_text]]),
                max([cap[3], *[r[3] for r in above], *[b[3] for b in nearby_text]])]
        # Include axis labels that sit to the left of the plot but within the column.
        records.append({
            "id": f"{doc_id}:p{page_number}:figure{match.group(2)}",
            "page": page_number,
            "text": text,
            "bbox": round_box(full, width, height),
            "chars": [],
            "source": "layout",
            "kind": "figure",
            "label": label,
        })
    # find_tables sometimes returns nested/overlapping boxes for one ruled
    # table.  Keep the largest box per caption label on this page.
    best_tables = {}
    non_tables = []
    for record in records:
        if record.get("kind") != "table":
            non_tables.append(record)
            continue
        label = record.get("label") or record["id"]
        area = (record["bbox"][2] - record["bbox"][0]) * (record["bbox"][3] - record["bbox"][1])
        previous = best_tables.get(label)
        if previous is None or area > previous[0]:
            best_tables[label] = (area, record)
    return non_tables + [item[1] for item in best_tables.values()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-dim", type=int, default=1600)
    parser.add_argument("--no-ocr", action="store_true")
    args = parser.parse_args()

    pdf_path = Path(args.pdf).resolve(strict=True)
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = out_path.parent / ".evidence-cache"
    work_dir.mkdir(parents=True, exist_ok=True)
    ps1 = Path(__file__).with_name("windows-ocr.ps1")

    digest = hashlib.sha256()
    with pdf_path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    doc_id = digest.hexdigest()[:16]

    records = []
    pages_meta = []
    ocr_pages = []
    warnings = []
    with pymupdf.open(pdf_path) as document:
        for page_number, page in enumerate(document, start=1):
            text_records = text_lines(page, page_number, doc_id)
            ocr_records = []
            if not args.no_ocr:
                try:
                    ocr_records = ocr_page(pdf_path, page, page_number, doc_id, work_dir, args.max_dim, ps1)
                    ocr_pages.append(page_number)
                except Exception as exc:  # keep text layer even if OCR fails
                    warnings.append({"page": page_number, "message": str(exc)[:300]})
            kept_ocr = dedupe_ocr(text_records, ocr_records)
            records.extend(text_records)
            records.extend(kept_ocr)
            records.extend(layout_blocks(page, page_number, doc_id))
            pages_meta.append({
                "page": page_number,
                "width": round(page.rect.width, 2),
                "height": round(page.rect.height, 2),
                "textLines": len(text_records),
                "ocrLinesKept": len(kept_ocr),
            })

    index = {
        "version": 5,
        "documentId": doc_id,
        "pdfPath": str(pdf_path),
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "pageCount": len(pages_meta),
        "pages": pages_meta,
        "records": records,
        "stats": {
            "pagesProcessed": list(range(1, len(pages_meta) + 1)),
            "ocrPages": ocr_pages,
            "textPages": [p["page"] for p in pages_meta if p["textLines"] > 0],
            "recordCount": len(records),
            "textRecords": sum(1 for r in records if r["source"] == "text"),
            "ocrRecords": sum(1 for r in records if r["source"] == "ocr"),
            "layoutRecords": sum(1 for r in records if r["source"] == "layout"),
            "tables": sum(1 for r in records if r.get("kind") == "table"),
            "figures": sum(1 for r in records if r.get("kind") == "figure"),
            "source": "pymupdf-text+windows-ocr" if ocr_pages else "pymupdf-text",
            "warnings": warnings,
        },
    }
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(out_path)
    print(json.dumps({
        "ok": True,
        "documentId": doc_id,
        "pageCount": index["pageCount"],
        "recordCount": len(records),
        "ocrPages": ocr_pages,
        "warnings": len(warnings),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)




