from __future__ import annotations

from dataclasses import dataclass


BRAND_COLORS = (
    "#22D3EE",
    "#7DD3FC",
    "#8B5CF6",
    "#A78BFA",
    "#EC4899",
    "#F472B6",
)

THEMES = {
    "dark": {
        "canvas": "#030014",
        "primary": "#E6EEFF",
        "secondary": "#64748B",
        "surface": "#11122A",
        "surface_alt": "#171A36",
        "shadow": "#000000",
    },
    "light": {
        "canvas": "#F7F9FF",
        "primary": "#17213A",
        "secondary": "#8090AA",
        "surface": "#FFFFFF",
        "surface_alt": "#E9EEFA",
        "shadow": "#A5B4D4",
    },
}


@dataclass(frozen=True)
class AssetSpec:
    category: str
    name: str
    theme: str
    state: str
    width: int
    height: int

    @property
    def slug(self) -> str:
        parts = [self.category.rstrip("s"), self.name]
        if self.state not in {"default", "master"}:
            parts.append(self.state)
        if self.theme != "universal":
            parts.append(self.theme)
        return "-".join(parts)


CAPABILITIES = (
    "self-evolution",
    "xiaomo",
    "team-development",
    "multi-agent",
    "multi-device",
    "resource-routing",
    "extension-incubation",
)

PEOPLE = ("aya", "bo", "chen", "dana", "neutral")
AGENT_ROLES = ("spark", "terminal", "code", "browser", "research", "planning")
AGENT_SHAPES = ("square", "hex")
DEVICES = ("web", "pc", "mobile")
DEVICE_SCREENS = ("empty", "sample")
RESOURCES = (
    "foundation-model",
    "reasoning-model",
    "cloud-server",
    "rack-server",
    "gpu",
    "workstation",
    "local-pc",
    "browser-test",
)
RELATIONS = ("connection", "traveler", "task-card", "status-label", "routing-path")


def build_inventory() -> list[AssetSpec]:
    specs: list[AssetSpec] = []

    for name in (
        "geometric-color",
        "monochrome-white",
        "monochrome-ink",
        "brand-gradient",
        "textured-color",
    ):
        specs.append(AssetSpec("logo", name, "universal", "master", 4096, 2560))

    for name in CAPABILITIES:
        for state in ("default", "active"):
            for theme in THEMES:
                specs.append(AssetSpec("capabilities", name, theme, state, 1024, 1024))

    for name in PEOPLE:
        for theme in THEMES:
            specs.append(AssetSpec("people", name, theme, "default", 1024, 1024))

    for role in AGENT_ROLES:
        for shape in AGENT_SHAPES:
            for theme in THEMES:
                specs.append(AssetSpec("agents", f"{role}-{shape}", theme, "default", 1024, 1024))

    for state in ("default", "running", "complete", "error"):
        for theme in THEMES:
            specs.append(AssetSpec("states", "node", theme, state, 1024, 1024))

    device_dimensions = {
        "web": (2160, 1350),
        "pc": (2160, 1620),
        "mobile": (1215, 2160),
    }
    for device in DEVICES:
        for screen in DEVICE_SCREENS:
            for theme in THEMES:
                width, height = device_dimensions[device]
                specs.append(AssetSpec("devices", f"{device}-{screen}", theme, "default", width, height))

    for name in RESOURCES:
        for state in ("default", "active"):
            for theme in THEMES:
                specs.append(AssetSpec("resources", name, theme, state, 1024, 1024))

    for name in RELATIONS:
        for theme in THEMES:
            specs.append(AssetSpec("relations", name, theme, "default", 1024, 1024))

    return specs


def validate_inventory(inventory: list[AssetSpec]) -> list[str]:
    errors: list[str] = []
    seen: set[tuple[str, str, str, str]] = set()
    allowed_themes = {*THEMES, "universal"}

    for item in inventory:
        key = (item.category, item.name, item.theme, item.state)
        if key in seen:
            errors.append(f"duplicate asset: {key}")
        seen.add(key)
        if item.theme not in allowed_themes:
            errors.append(f"invalid theme for {item.slug}: {item.theme}")
        if item.width <= 0 or item.height <= 0:
            errors.append(f"invalid dimensions for {item.slug}: {item.width}x{item.height}")
        if item.width > 4096 or item.height > 4096:
            errors.append(f"oversized asset for {item.slug}: {item.width}x{item.height}")

    return errors
