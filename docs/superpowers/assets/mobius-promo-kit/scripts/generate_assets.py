from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import cairosvg
from PIL import Image


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


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Mobius promotional asset kit.")
    parser.add_argument("--output", type=Path, default=KIT_ROOT)
    args = parser.parse_args()
    records = generate_all(args.output)
    counts = Counter(record["category"] for record in records)
    summary = ", ".join(f"{category}={counts[category]}" for category in sorted(counts))
    print(f"Generated {len(records)} assets ({summary})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
