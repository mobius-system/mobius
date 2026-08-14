#!/usr/bin/env python3
"""Extract a text-first, page-addressable research document from a PDF."""

from __future__ import annotations

import json
import html
import re
import statistics
import sys
import unicodedata
from pathlib import Path

import fitz


MAX_PAGES = 800
MAX_DOCUMENT_CHARS = 4_000_000


def clean_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value or "")
    value = value.replace("\u00ad", "").replace("\u200b", "")
    # PDF 字体映射失败时会留下 C0 控制字符；它们既不能帮助阅读，也会破坏
    # Markdown/JSON/KaTeX 渲染。保留换行和制表符，其余控制字符直接丢弃。
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    return value.strip()


def join_lines(lines: list[str]) -> str:
    out = ""
    for raw in lines:
        line = clean_text(raw)
        if not line:
            continue
        if out.endswith("-") and line[:1].islower():
            out = out[:-1] + line
        elif out:
            out += " " + line
        else:
            out = line
    return clean_text(out)


def line_text(line: dict) -> str:
    return "".join(str(span.get("text") or "") for span in line.get("spans") or [])


def block_text(block: dict) -> str:
    return join_lines([line_text(line) for line in block.get("lines") or []])


def block_bbox(block: dict) -> tuple[float, float, float, float]:
    rect = block.get("bbox") or [0, 0, 0, 0]
    return tuple(float(x or 0) for x in (list(rect) + [0, 0, 0, 0])[:4])


def is_graph_garbage(text: str) -> bool:
    """过滤图中坐标轴/逐字母字体映射，不误删正常正文和公式。"""
    compact = clean_text(text)
    if not compact:
        return False
    if re.fullmatch(r"(?:\d\s*[.,]?\s*){2,}", compact):
        return True
    letters = re.findall(r"[A-Za-z]", compact)
    spaced = len(re.findall(r"(?<![A-Za-z])[A-Za-z](?:\s+[A-Za-z]){3,}(?![A-Za-z])", compact))
    return len(letters) >= 8 and spaced >= 1 and len(re.sub(r"\s+", "", compact)) <= 100


def order_page_blocks(blocks: list[dict], page_width: float, page_height: float) -> list[dict]:
    """按版面区域排序：宽块先作为跨栏内容，其余按列整段阅读。"""
    text_blocks = [b for b in blocks if b.get("type") == 0 and block_text(b)]
    if len(text_blocks) < 4:
        return sorted(text_blocks, key=lambda b: (block_bbox(b)[1], block_bbox(b)[0]))
    wide, narrow = [], []
    for block in text_blocks:
        x0, y0, x1, y1 = block_bbox(block)
        if (x1 - x0) >= page_width * 0.68 or (x0 <= page_width * 0.08 and x1 >= page_width * 0.92):
            wide.append(block)
        else:
            narrow.append(block)
    # 用长正文块的 x0 聚类，而不是所有小标题/公式的中位数；后者会把居中标题
    # 当成一列，正是双栏论文最常见的错序来源。
    candidates = [b for b in narrow if len(block_text(b)) >= 120]
    left = [b for b in candidates if block_bbox(b)[0] < page_width / 2]
    right = [b for b in candidates if block_bbox(b)[0] >= page_width / 2]
    two_columns = len(left) >= 2 and len(right) >= 2
    split = page_width / 2
    if two_columns:
        left = [b for b in narrow if block_bbox(b)[0] < split]
        right = [b for b in narrow if block_bbox(b)[0] >= split]
    if not two_columns:
        return sorted(text_blocks, key=lambda b: (block_bbox(b)[1], block_bbox(b)[0]))

    # 宽块（表格、标题、图注）把页面切成多个垂直 band；每个 band 内先左栏再右栏。
    boundaries = sorted({0.0, page_height, *[max(0.0, min(page_height, block_bbox(b)[1])) for b in wide],
                         *[max(0.0, min(page_height, block_bbox(b)[3])) for b in wide]})
    ordered = []
    for start, end in zip(boundaries, boundaries[1:]):
        band_wide = [b for b in wide if block_bbox(b)[1] >= start - 1 and block_bbox(b)[1] < end + 1]
        band_left = [b for b in left if block_bbox(b)[1] >= start - 1 and block_bbox(b)[1] < end + 1]
        band_right = [b for b in right if block_bbox(b)[1] >= start - 1 and block_bbox(b)[1] < end + 1]
        ordered.extend(sorted(band_wide, key=lambda b: (block_bbox(b)[1], block_bbox(b)[0])))
        ordered.extend(sorted(band_left, key=lambda b: (block_bbox(b)[1], block_bbox(b)[0])))
        ordered.extend(sorted(band_right, key=lambda b: (block_bbox(b)[1], block_bbox(b)[0])))
    return ordered


def assess_quality(pages: list[dict], raw_characters: int) -> dict:
    text = "\n".join(str(page.get("text") or "") for page in pages)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    control_count = sum(1 for char in text if ord(char) < 32 and char not in "\n\t\r")
    spaced_lines = sum(1 for line in lines if is_graph_garbage(line) and re.search(r"[A-Za-z]", line))
    numeric_lines = sum(1 for line in lines if re.fullmatch(r"(?:\d\s*[.,]?\s*){2,}", line))
    formula_heading_count = sum(1 for page in pages for section in page.get("sections") or []
                                if re.search(r"[=∑∥λγξν]|\(\d+\)", str(section.get("title") or "")))
    two_column_pages = sum(1 for page in pages if page.get("two_columns"))
    figure_pages = sum(1 for page in pages if page.get("has_figures"))
    score = 100
    score -= min(35, control_count * 5)
    score -= min(25, spaced_lines * 3)
    score -= min(15, numeric_lines * 2)
    score -= min(25, formula_heading_count * 6)
    if two_column_pages:
        score -= min(18, two_column_pages * 3)
    score = max(0, int(score))
    status = "fast_ready" if score >= 82 else "needs_enhanced_parse"
    reasons = []
    if two_column_pages: reasons.append(f"检测到 {two_column_pages} 页双栏版面")
    if figure_pages: reasons.append(f"检测到 {figure_pages} 页图表区域")
    if control_count: reasons.append(f"存在 {control_count} 个字体控制字符")
    if spaced_lines: reasons.append(f"存在 {spaced_lines} 行疑似图内逐字母文本")
    if numeric_lines: reasons.append(f"存在 {numeric_lines} 行疑似坐标轴数字")
    if formula_heading_count: reasons.append(f"{formula_heading_count} 个公式被误判为标题")
    return {"score": score, "status": status, "reasons": reasons,
            "control_characters": control_count, "spaced_lines": spaced_lines,
            "numeric_lines": numeric_lines, "formula_headings": formula_heading_count,
            "two_column_pages": two_column_pages, "figure_pages": figure_pages,
            "raw_characters": raw_characters}


def span_sizes(document: fitz.Document) -> list[float]:
    sizes: list[float] = []
    sampled_chars = 0
    for page_index in range(min(document.page_count, 40)):
        data = document.load_page(page_index).get_text("dict", sort=True)
        for block in data.get("blocks") or []:
            for line in block.get("lines") or []:
                for span in line.get("spans") or []:
                    text = clean_text(str(span.get("text") or ""))
                    if not text:
                        continue
                    size = float(span.get("size") or 0)
                    sizes.extend([size] * min(len(text), 80))
                    sampled_chars += len(text)
                    if sampled_chars >= 80_000:
                        return sizes
    return sizes


def looks_like_heading(text: str, max_size: float, body_size: float, bold: bool) -> bool:
    compact = clean_text(text)
    if not compact or len(compact) > 180 or compact.endswith(('.', ',', ';', ':')):
        return False
    numbered = bool(re.match(r"^(?:\d+(?:\.\d+)*|[IVX]+)\.?\s+\S", compact, re.I))
    named = bool(re.match(r"^(?:abstract|introduction|background|related work|method(?:ology)?|approach|experiments?|results?|discussion|limitations?|conclusion|references|appendix)\b", compact, re.I))
    return max_size >= body_size * 1.22 or ((numbered or named) and max_size >= body_size * 0.98) or (bold and max_size >= body_size * 1.04 and (numbered or named))


def heading_level(size: float, body_size: float) -> int:
    if size >= body_size * 1.65:
        return 2
    if size >= body_size * 1.34:
        return 3
    return 4


def infer_abstract(text: str) -> str:
    match = re.search(
        r"\babstract\b\s*[:.-]?\s*(.{80,6000}?)(?=\n\s*(?:1\.?\s+)?(?:introduction|background)\b)",
        text,
        re.I | re.S,
    )
    if not match:
        return ""
    return clean_text(match.group(1))[:5000]


def infer_title(first_page_blocks: list[dict], body_size: float, fallback: str) -> str:
    candidates: list[tuple[float, str]] = []
    for block in first_page_blocks[:14]:
        text = block_text(block)
        if not 8 <= len(text) <= 320:
            continue
        if re.match(r"^arXiv:\S+", text, re.I):
            continue
        sizes = [float(span.get("size") or 0) for line in block.get("lines") or [] for span in line.get("spans") or []]
        if sizes:
            candidates.append((max(sizes), text))
    if candidates:
        size, title = max(candidates, key=lambda item: (item[0], len(item[1])))
        if size >= body_size * 1.2:
            return title
    return fallback


def infer_authors(first_page_blocks: list[dict], title: str) -> str:
    candidates = []
    seen_title = False
    for block in first_page_blocks[:12]:
        text = block_text(block)
        if not text:
            continue
        if text == title:
            seen_title = True
            continue
        if not seen_title:
            continue
        if re.match(r"^abstract\b", text, re.I):
            break
        if len(text) <= 320 and not re.search(r"@|university|institute|laboratory|arxiv:", text, re.I):
            candidates.append(text)
        if len(candidates) >= 2:
            break
    return clean_text("; ".join(candidates))


def extract(pdf_path: Path) -> dict:
    document = fitz.open(pdf_path)
    if document.needs_pass:
        raise ValueError("PDF 已加密，暂时无法解析")
    if document.page_count < 1:
        raise ValueError("PDF 没有可读取的页面")
    if document.page_count > MAX_PAGES:
        raise ValueError(f"PDF 页数超过上限（{MAX_PAGES} 页）")

    sizes = span_sizes(document)
    body_size = statistics.median(sizes) if sizes else 10.0
    metadata = document.metadata or {}
    pages = []
    plain_parts = []
    markdown_parts = []
    first_page_blocks: list[dict] = []
    total_chars = 0

    for page_number in range(document.page_count):
        page = document.load_page(page_number)
        data = page.get_text("dict", sort=True)
        raw_blocks = [block for block in data.get("blocks") or [] if block.get("type") in (0, 1)]
        blocks = order_page_blocks(raw_blocks, float(page.rect.width), float(page.rect.height))
        block_texts = [block_text(block) for block in blocks]
        two_columns = False
        long_narrow_x = [block_bbox(b)[0] for b in blocks
                         if block_bbox(b)[2] - block_bbox(b)[0] < float(page.rect.width) * .68
                         and len(block_text(b)) >= 120]
        if len(long_narrow_x) >= 4:
            mid = float(page.rect.width) / 2
            two_columns = sum(x < mid for x in long_narrow_x) >= 2 and sum(x >= mid for x in long_narrow_x) >= 2
        has_figures = any(b.get("type") == 1 for b in raw_blocks) or any(re.search(r"\b(?:figure|fig\.|table)\s*\d", t, re.I) for t in block_texts)
        if page_number == 0:
            first_page_blocks = blocks
        page_plain = []
        page_markdown = []
        sections = []
        for block in blocks:
            text = block_text(block)
            if not text:
                continue
            if is_graph_garbage(text) and not re.match(r"^(?:figure|fig\.|table)\s*\d", text, re.I):
                continue
            if page_number == 0 and re.match(r"^arXiv:\S+", text, re.I):
                continue
            spans = [span for line in block.get("lines") or [] for span in line.get("spans") or []]
            block_sizes = [float(span.get("size") or 0) for span in spans]
            max_size = max(block_sizes) if block_sizes else body_size
            bold = any("bold" in str(span.get("font") or "").lower() for span in spans)
            page_plain.append(text)
            markdown_text = html.escape(text, quote=False)
            if looks_like_heading(text, max_size, body_size, bold):
                level = heading_level(max_size, body_size)
                page_markdown.append(f"{'#' * level} {markdown_text}")
                sections.append({"title": text, "level": level})
            else:
                page_markdown.append(markdown_text)
        page_text = "\n\n".join(page_plain).strip()
        markdown = "\n\n".join(page_markdown).strip()
        total_chars += len(page_text)
        pages.append({
            "page_number": page_number + 1,
            "width": round(float(page.rect.width), 2),
            "height": round(float(page.rect.height), 2),
            "text": page_text,
            "markdown": markdown,
            "sections": sections,
            "two_columns": two_columns,
            "has_figures": has_figures,
        })
        plain_parts.append(f"[Page {page_number + 1}]\n{page_text}")
        markdown_parts.append(f"<div class=\"pr-page-marker\" data-page=\"{page_number + 1}\">Page {page_number + 1}</div>\n\n{markdown}")
        if total_chars > MAX_DOCUMENT_CHARS:
            raise ValueError("PDF 提取文本超过 400 万字符上限")

    plain_text = "\n\n".join(plain_parts).strip()
    document_markdown = "\n\n".join(markdown_parts).strip()
    fallback_title = re.sub(r"[_-]+", " ", pdf_path.stem).strip() or "Uploaded paper"
    metadata_title = clean_text(str(metadata.get("title") or ""))
    if metadata_title.lower() in {"untitled", "unknown", "none"}:
        metadata_title = ""
    title = metadata_title or infer_title(first_page_blocks, body_size, fallback_title)
    authors = clean_text(str(metadata.get("author") or "")) or infer_authors(first_page_blocks, title)
    abstract = infer_abstract(plain_text)
    quality = assess_quality(pages, total_chars)
    status = "needs_ocr" if total_chars < max(240, document.page_count * 80) else quality["status"]
    return {
        "parser": "pymupdf-local-v1",
        "title": title[:600],
        "authors": authors[:600],
        "abstract": abstract,
        "page_count": document.page_count,
        "character_count": total_chars,
        "extraction_status": status,
        "quality": quality,
        "document_markdown": document_markdown,
        "plain_text": plain_text,
        "pages": pages,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: extract_pdf.py <pdf>"}))
        return 2
    try:
        result = extract(Path(sys.argv[1]).resolve())
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
