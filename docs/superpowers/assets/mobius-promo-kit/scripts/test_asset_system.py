from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from asset_system import (  # noqa: E402
    BRAND_COLORS,
    THEMES,
    build_inventory,
    validate_inventory,
)


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


if __name__ == "__main__":
    unittest.main()
