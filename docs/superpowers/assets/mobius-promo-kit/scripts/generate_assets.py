from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageFilter, ImageFont


SCRIPT_DIR = Path(__file__).resolve().parent
KIT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from asset_system import AssetSpec, build_inventory, render_svg, validate_inventory  # noqa: E402


CATEGORY_FOLDERS = {
    "logo": "01-logo",
    "capabilities": "02-capabilities",
    "people": "03-people-agents",
    "agents": "03-people-agents",
    "states": "03-people-agents",
    "devices": "04-device-frames",
    "resources": "05-compute-resources",
    "relations": "06-motion-guides",
}

BOARD_GROUPS = {
    "overview": ("logo", "capabilities", "people", "agents", "states", "devices", "resources", "relations"),
    "capabilities": ("capabilities",),
    "people-agents": ("people", "agents", "states"),
    "devices": ("devices",),
    "compute-resources": ("resources",),
    "motion-accessories": ("relations",),
}

BOARD_TITLES = {
    "overview": "Mobius 宣传片素材总览",
    "capabilities": "七项能力 · 默认与激活",
    "people-agents": "人类成员与智能体节点",
    "devices": "Web · PC · 移动端设备框",
    "compute-resources": "模型 · 服务器 · GPU · 设备",
    "motion-accessories": "连接关系与动画配件",
}


def output_paths(output_root: Path, spec: AssetSpec) -> tuple[Path, Path]:
    category_root = output_root / CATEGORY_FOLDERS[spec.category]
    return (
        category_root / "svg" / f"{spec.slug}.svg",
        category_root / "png" / f"{spec.slug}.png",
    )


def manifest_record(
    output_root: Path,
    spec: AssetSpec,
    svg_path: Path,
    png_path: Path,
) -> dict[str, object]:
    return {
        "category": spec.category,
        "name": spec.name,
        "theme": spec.theme,
        "state": spec.state,
        "width": spec.width,
        "height": spec.height,
        "svg": svg_path.relative_to(output_root).as_posix(),
        "png": png_path.relative_to(output_root).as_posix(),
    }


def _ensure_rgba(path: Path) -> None:
    with Image.open(path) as image:
        if image.mode == "RGBA":
            return
        rgba = image.convert("RGBA")
        rgba.save(path, optimize=True)


def generate_all(
    output_root: Path = KIT_ROOT,
    *,
    inventory: list[AssetSpec] | None = None,
) -> list[dict[str, object]]:
    selected = list(build_inventory() if inventory is None else inventory)
    errors = validate_inventory(selected)
    if errors:
        raise ValueError("Invalid asset inventory:\n" + "\n".join(errors))

    records: list[dict[str, object]] = []
    for spec in selected:
        svg_path, png_path = output_paths(output_root, spec)
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        png_path.parent.mkdir(parents=True, exist_ok=True)
        svg = render_svg(spec)
        svg_path.write_text(svg, encoding="utf-8")
        cairosvg.svg2png(
            bytestring=svg.encode("utf-8"),
            write_to=str(png_path),
            output_width=spec.width,
            output_height=spec.height,
        )
        _ensure_rgba(png_path)
        records.append(manifest_record(output_root, spec, svg_path, png_path))

    manifest = {
        "name": "Mobius Promo Asset Kit",
        "version": "1.0.0",
        "asset_count": len(records),
        "assets": records,
    }
    (output_root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return records


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    filename = "NotoSansCJK-Bold.ttc" if bold else "NotoSansCJK-Regular.ttc"
    path = Path("/usr/share/fonts/opentype/noto") / filename
    if path.is_file():
        return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def _preview_background(theme: str) -> Image.Image:
    color = (3, 0, 20) if theme == "dark" else (247, 249, 255)
    canvas = Image.new("RGB", (3840, 2160), color)
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    if theme == "dark":
        draw.ellipse((-500, -900, 2100, 1300), fill=(34, 211, 238, 34))
        draw.ellipse((1900, -600, 4500, 1600), fill=(139, 92, 246, 40))
        draw.ellipse((900, 1100, 3200, 2800), fill=(236, 72, 153, 24))
    else:
        draw.ellipse((-400, -700, 1900, 1200), fill=(34, 211, 238, 24))
        draw.ellipse((2100, -600, 4400, 1500), fill=(139, 92, 246, 22))
        draw.ellipse((1100, 1200, 3100, 2700), fill=(236, 72, 153, 15))
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    return Image.alpha_composite(canvas.convert("RGBA"), glow)


def _select_board_records(
    records: list[dict[str, object]],
    categories: tuple[str, ...],
    theme: str,
) -> list[dict[str, object]]:
    selected = [
        record
        for record in records
        if record["category"] in categories and record["theme"] in {theme, "universal"}
    ]
    incompatible_logo = "monochrome-ink" if theme == "dark" else "monochrome-white"
    selected = [
        record
        for record in selected
        if not (record["category"] == "logo" and record["name"] == incompatible_logo)
    ]
    if len(categories) > 1:
        priority: list[dict[str, object]] = []
        for category in categories:
            category_records = [record for record in selected if record["category"] == category]
            active = [record for record in category_records if record["state"] in {"active", "running", "complete"}]
            defaults = [record for record in category_records if record["state"] in {"default", "master"}]
            priority.extend((active + defaults)[:4])
        selected = priority
    return selected[:18]


def _draw_asset_card(
    board: Image.Image,
    record: dict[str, object],
    output_root: Path,
    x: int,
    y: int,
    theme: str,
) -> None:
    draw = ImageDraw.Draw(board)
    card_fill = (16, 18, 43, 218) if theme == "dark" else (255, 255, 255, 224)
    card_outline = (125, 211, 252, 58) if theme == "dark" else (128, 144, 170, 52)
    draw.rounded_rectangle((x, y, x + 540, y + 500), radius=34, fill=card_fill, outline=card_outline, width=2)

    with Image.open(output_root / str(record["png"])) as source:
        artwork = source.convert("RGBA")
        artwork.thumbnail((390, 340), Image.Resampling.LANCZOS)
    art_x = x + (540 - artwork.width) // 2
    art_y = y + 34 + (340 - artwork.height) // 2
    board.alpha_composite(artwork, (art_x, art_y))

    title_color = (230, 238, 255, 255) if theme == "dark" else (23, 33, 58, 255)
    meta_color = (148, 163, 184, 255) if theme == "dark" else (100, 116, 139, 255)
    label = str(record["name"]).replace("-", " · ")
    if len(label) > 30:
        label = label[:29] + "…"
    draw.text((x + 28, y + 394), label, font=_font(27, bold=True), fill=title_color)
    meta = f'{record["category"]}  /  {record["state"]}  /  {record["width"]}×{record["height"]}'
    draw.text((x + 28, y + 443), meta, font=_font(21), fill=meta_color)


def build_preview_boards(
    output_root: Path,
    records: list[dict[str, object]],
) -> list[Path]:
    preview_root = output_root / "00-preview"
    preview_root.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []

    for group, categories in BOARD_GROUPS.items():
        for theme in ("dark", "light"):
            selected = _select_board_records(records, categories, theme)
            if not selected:
                continue
            board = _preview_background(theme)
            draw = ImageDraw.Draw(board)
            title_color = (230, 238, 255, 255) if theme == "dark" else (23, 33, 58, 255)
            meta_color = (148, 163, 184, 255) if theme == "dark" else (100, 116, 139, 255)
            draw.text((200, 104), BOARD_TITLES[group], font=_font(72, bold=True), fill=title_color)
            draw.text(
                (204, 205),
                f"SYSTEM LINEWORK  /  BRAND ENERGY TRAIL  /  {theme.upper()}  /  {len(selected)} SAMPLES",
                font=_font(27),
                fill=meta_color,
            )
            draw.line((200, 267, 3640, 267), fill=(125, 211, 252, 80), width=2)

            for index, record in enumerate(selected):
                row, column = divmod(index, 6)
                _draw_asset_card(board, record, output_root, 200 + column * 580, 330 + row * 560, theme)

            draw.text(
                (200, 2070),
                "Mobius · 塑造属于你的 Agent OS",
                font=_font(26, bold=True),
                fill=meta_color,
            )
            path = preview_root / f"{group}-{theme}-4k.png"
            board.convert("RGB").save(path, quality=94, optimize=True)
            paths.append(path)

    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Mobius promotional asset kit.")
    parser.add_argument("--output", type=Path, default=KIT_ROOT)
    args = parser.parse_args()
    records = generate_all(args.output)
    boards = build_preview_boards(args.output, records)
    counts = Counter(record["category"] for record in records)
    summary = ", ".join(f"{category}={counts[category]}" for category in sorted(counts))
    print(f"Generated {len(records)} assets and {len(boards)} preview boards ({summary})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
