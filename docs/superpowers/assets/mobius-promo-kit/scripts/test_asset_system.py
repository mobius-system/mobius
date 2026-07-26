from __future__ import annotations

import json
import sys
import tempfile
import unittest
from xml.etree import ElementTree
from pathlib import Path

from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from asset_system import (  # noqa: E402
    BRAND_COLORS,
    THEMES,
    build_inventory,
    render_svg,
    validate_inventory,
)
from generate_assets import _select_board_records, build_preview_boards, generate_all  # noqa: E402


class InventoryTests(unittest.TestCase):
    def test_inventory_contains_all_required_categories(self) -> None:
        inventory = build_inventory()
        self.assertEqual(
            {item.category for item in inventory},
            {
                "logo",
                "capabilities",
                "people",
                "agents",
                "states",
                "devices",
                "resources",
                "relations",
            },
        )

    def test_inventory_has_expected_total_and_unique_names(self) -> None:
        inventory = build_inventory()
        self.assertEqual(len(inventory), 129)
        keys = {(item.category, item.name, item.theme, item.state) for item in inventory}
        self.assertEqual(len(keys), len(inventory))

    def test_capabilities_cover_seven_concepts_in_two_states_and_themes(self) -> None:
        items = [item for item in build_inventory() if item.category == "capabilities"]
        self.assertEqual(len(items), 7 * 2 * 2)
        self.assertEqual(
            {item.name for item in items},
            {
                "self-evolution",
                "xiaomo",
                "team-development",
                "multi-agent",
                "multi-device",
                "resource-routing",
                "extension-incubation",
            },
        )

    def test_agents_cover_six_roles_and_two_node_shapes(self) -> None:
        items = [item for item in build_inventory() if item.category == "agents"]
        self.assertEqual(len(items), 6 * 2 * 2)
        self.assertEqual(
            {item.name.split("-")[0] for item in items},
            {"spark", "terminal", "code", "browser", "research", "planning"},
        )
        self.assertEqual(
            {item.name.rsplit("-", 1)[1] for item in items},
            {"square", "hex"},
        )

    def test_devices_use_a_2160_pixel_long_edge(self) -> None:
        items = [item for item in build_inventory() if item.category == "devices"]
        self.assertEqual(len(items), 3 * 2 * 2)
        for item in items:
            self.assertEqual(max(item.width, item.height), 2160)

    def test_brand_palette_and_theme_tokens_are_exact(self) -> None:
        self.assertEqual(
            BRAND_COLORS,
            ("#22D3EE", "#7DD3FC", "#8B5CF6", "#A78BFA", "#EC4899", "#F472B6"),
        )
        self.assertEqual(THEMES["dark"]["canvas"], "#030014")
        self.assertEqual(THEMES["light"]["canvas"], "#F7F9FF")

    def test_inventory_validator_accepts_the_production_matrix(self) -> None:
        self.assertEqual(validate_inventory(build_inventory()), [])

    def test_capability_slug_uses_the_correct_singular_prefix(self) -> None:
        capability = next(item for item in build_inventory() if item.category == "capabilities")
        self.assertTrue(capability.slug.startswith("capability-"), capability.slug)


class SvgContractTests(unittest.TestCase):
    def test_every_asset_renders_parseable_transparent_svg(self) -> None:
        for spec in build_inventory():
            with self.subTest(asset=spec.slug):
                svg = render_svg(spec)
                root = ElementTree.fromstring(svg)
                self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
                self.assertIn("viewBox", root.attrib)
                self.assertNotIn("background", root.attrib)
                self.assertNotIn('id="background"', svg)
                self.assertIn('id="icon-structure"', svg)
                self.assertFalse(
                    any(line != line.rstrip() for line in svg.splitlines()),
                    f"trailing whitespace in {spec.slug}",
                )

    def test_active_assets_define_brand_gradient_and_energy_layer(self) -> None:
        active_assets = [item for item in build_inventory() if item.state == "active"]
        self.assertTrue(active_assets)
        for spec in active_assets:
            with self.subTest(asset=spec.slug):
                svg = render_svg(spec)
                self.assertIn('id="brand-gradient"', svg)
                self.assertIn('id="energy-trail"', svg)

    def test_category_specific_semantic_layers_are_present(self) -> None:
        expected = {
            "logo": "mobius-ribbon",
            "capabilities": "capability-symbol",
            "people": "portrait",
            "agents": "agent-core",
            "states": "state-indicator",
            "devices": "device-screen",
            "resources": "resource-symbol",
            "relations": "relation-path",
        }
        examples = {}
        for item in build_inventory():
            examples.setdefault(item.category, item)
        for category, layer_id in expected.items():
            with self.subTest(category=category):
                self.assertIn(f'id="{layer_id}"', render_svg(examples[category]))


class ExportTests(unittest.TestCase):
    def test_generate_all_writes_svg_png_and_consistent_manifest(self) -> None:
        subset = [item for item in build_inventory() if item.category == "capabilities"][:3]
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp)
            records = generate_all(output_root, inventory=subset)
            self.assertEqual(len(records), len(subset))
            manifest = json.loads((output_root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(records, manifest["assets"])
            for record, spec in zip(records, subset, strict=True):
                svg_path = output_root / record["svg"]
                png_path = output_root / record["png"]
                self.assertTrue(svg_path.is_file())
                self.assertTrue(png_path.is_file())
                with Image.open(png_path) as image:
                    self.assertEqual(image.size, (spec.width, spec.height))
                    self.assertEqual(image.mode, "RGBA")

    def test_export_paths_are_grouped_by_public_category(self) -> None:
        subset = [
            next(item for item in build_inventory() if item.category == category)
            for category in ("logo", "capabilities", "people", "devices", "resources")
        ]
        with tempfile.TemporaryDirectory() as tmp:
            records = generate_all(Path(tmp), inventory=subset)
        top_folders = {Path(record["svg"]).parts[0] for record in records}
        self.assertEqual(
            top_folders,
            {"01-logo", "02-capabilities", "03-people-agents", "04-device-frames", "05-compute-resources"},
        )

    def test_preview_boards_are_4k_images_in_both_themes(self) -> None:
        subset = [item for item in build_inventory() if item.category == "capabilities"][:8]
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp)
            records = generate_all(output_root, inventory=subset)
            boards = build_preview_boards(output_root, records)
            self.assertGreaterEqual(len(boards), 2)
            self.assertTrue(any("dark" in path.name for path in boards))
            self.assertTrue(any("light" in path.name for path in boards))
            for path in boards:
                with Image.open(path) as image:
                    self.assertEqual(image.size, (3840, 2160))
                    self.assertIn(image.mode, {"RGB", "RGBA"})

    def test_overview_uses_theme_compatible_logo_samples(self) -> None:
        records = [
            {
                "category": item.category,
                "name": item.name,
                "theme": item.theme,
                "state": item.state,
            }
            for item in build_inventory()
        ]
        categories = ("logo", "capabilities", "people", "agents")
        dark_names = {record["name"] for record in _select_board_records(records, categories, "dark")}
        light_names = {record["name"] for record in _select_board_records(records, categories, "light")}
        self.assertNotIn("monochrome-ink", dark_names)
        self.assertNotIn("monochrome-white", light_names)
        self.assertIn("textured-color", dark_names)
        self.assertIn("textured-color", light_names)


if __name__ == "__main__":
    unittest.main()
