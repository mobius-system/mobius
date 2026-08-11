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
        blocks = [block for block in data.get("blocks") or [] if block.get("type") == 0]
        if page_number == 0:
            first_page_blocks = blocks
        page_plain = []
        page_markdown = []
        sections = []
        for block in blocks:
            text = block_text(block)
            if not text:
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
    status = "ready" if total_chars >= max(240, document.page_count * 80) else "needs_ocr"
    return {
        "parser": "pymupdf-local-v1",
        "title": title[:600],
        "authors": authors[:600],
        "abstract": abstract,
        "page_count": document.page_count,
        "character_count": total_chars,
        "extraction_status": status,
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
