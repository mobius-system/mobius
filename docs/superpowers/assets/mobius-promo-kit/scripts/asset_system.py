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


def _view_box(spec: AssetSpec) -> tuple[int, int]:
    if spec.category == "logo":
        return (160, 100)
    if spec.category == "devices":
        device = spec.name.split("-", 1)[0]
        return {"web": (160, 100), "pc": (160, 120), "mobile": (90, 160)}[device]
    if spec.category == "relations":
        return (160, 96)
    return (96, 96)


def _paint(spec: AssetSpec, *, active: bool | None = None) -> str:
    if active is None:
        active = spec.state == "active"
    if spec.category == "logo" and spec.name in {"geometric-color", "brand-gradient", "textured-color"}:
        active = True
    if active:
        return "url(#brand-gradient)"
    if spec.theme == "universal":
        if spec.name == "monochrome-white":
            return "#FFFFFF"
        if spec.name == "monochrome-ink":
            return "#17213A"
        return "#8B5CF6"
    return THEMES[spec.theme]["primary"]


def _secondary(spec: AssetSpec) -> str:
    if spec.theme == "universal":
        return "#A78BFA"
    return THEMES[spec.theme]["secondary"]


def _surface(spec: AssetSpec) -> str:
    if spec.theme == "universal":
        return "#11122A"
    return THEMES[spec.theme]["surface"]


def _stroke(color: str, width: float = 3, opacity: float = 1) -> str:
    return (
        f'fill="none" stroke="{color}" stroke-width="{width}" '
        f'stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}"'
    )


def _defs() -> str:
    stops = "".join(
        f'<stop offset="{index * 20}%" stop-color="{color}"/>'
        for index, color in enumerate(BRAND_COLORS)
    )
    return f"""
    <defs>
      <linearGradient id="brand-gradient" x1="0%" y1="0%" x2="100%" y2="100%">{stops}</linearGradient>
      <radialGradient id="brand-glass" cx="38%" cy="28%" r="78%">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.72"/>
        <stop offset="28%" stop-color="#7DD3FC" stop-opacity="0.42"/>
        <stop offset="66%" stop-color="#8B5CF6" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#EC4899" stop-opacity="0.12"/>
      </radialGradient>
      <filter id="soft-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="2.2" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="wide-glow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>"""


def _svg_document(spec: AssetSpec, body: str) -> str:
    width, height = _view_box(spec)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{spec.width}" height="{spec.height}" viewBox="0 0 {width} {height}" role="img" aria-label="{spec.slug}">
{_defs()}
{body}
</svg>
"""


def _energy_group(spec: AssetSpec, content: str) -> str:
    opacity = "1" if spec.state == "active" else "0"
    return f'<g id="energy-trail" opacity="{opacity}" filter="url(#soft-glow)">{content}</g>'


def _logo(spec: AssetSpec) -> str:
    paint = _paint(spec)
    texture = ""
    if spec.name == "textured-color":
        particles = (
            (31, 41, 1.3), (39, 57, 0.8), (51, 32, 1.1), (59, 66, 1.5),
            (70, 42, 0.7), (79, 55, 1.4), (88, 39, 0.9), (99, 60, 1.2),
            (111, 34, 1.1), (121, 55, 1.5), (132, 43, 0.8),
        )
        texture = '<g id="texture-particles">' + "".join(
            f'<circle cx="{x}" cy="{y}" r="{r}" fill="#FFFFFF" opacity="0.78"/>'
            for x, y, r in particles
        ) + "</g>"
    ribbon = (
        '<path d="M18 51 C28 20 53 18 80 50 C107 82 132 80 142 49 '
        'C132 18 107 18 80 50 C53 82 28 82 18 51" '
        f'{_stroke(paint, 16)} filter="url(#soft-glow)"/>'
        '<path d="M22 48 C34 27 52 27 68 42" '
        f'{_stroke("#FFFFFF", 2.1, 0.62)}/>'
        '<path d="M49 72 C61 66 70 57 80 50 C91 42 101 33 113 28" '
        f'{_stroke(paint, 16)}/>'
        '<path d="M52 68 C62 63 71 55 82 47 C91 40 99 34 108 31" '
        f'{_stroke("#FFFFFF", 1.8, 0.48)}/>'
    )
    return (
        f'<g id="icon-structure"><g id="mobius-ribbon">{ribbon}</g>{texture}</g>'
        '<g id="energy-trail" opacity="0.9" filter="url(#wide-glow)">'
        '<circle cx="112" cy="29" r="2.2" fill="#FDE68A"/>'
        '<circle cx="48" cy="70" r="1.4" fill="#FFFFFF"/></g>'
    )


def _capability(spec: AssetSpec) -> str:
    primary = _paint(spec)
    secondary = _secondary(spec)
    common = _stroke(primary)
    faint = _stroke(secondary, 2, 0.78)

    if spec.name == "self-evolution":
        symbol = f"""
          <path d="M15 48 C23 28 36 29 48 48 C60 67 73 68 81 48 C73 28 60 29 48 48 C36 67 23 68 15 48" {common}/>
          <rect x="59" y="14" width="22" height="16" rx="4" {faint}/>
          <path d="M65 22h10M70 17v10" {faint}/>
          <circle cx="80" cy="32" r="4" fill="{primary}"/>
        """
        energy = f'<path d="M21 42 C31 25 45 39 52 51 C62 68 76 62 80 48" {_stroke("url(#brand-gradient)", 3.2)}/>'
    elif spec.name == "xiaomo":
        symbol = f"""
          <path d="M42 14 L46 28 L58 20 L52 34 L68 33 L55 42 L69 50 L53 49 L58 64 L46 54 L41 70 L38 54 L25 64 L31 49 L15 50 L29 41 L16 33 L32 34 L26 20 L38 28 Z" {common}/>
          <path d="M58 56h21a7 7 0 0 1 7 7v9a7 7 0 0 1-7 7H69l-7 6v-6h-4a7 7 0 0 1-7-7v-6" {faint}/>
          <path d="M62 66h12M62 72h8" {faint}/>
        """
        energy = f'<path d="M42 17 L46 32 L59 23" {_stroke("url(#brand-gradient)", 3.4)}/>'
    elif spec.name == "team-development":
        symbol = f"""
          <rect x="23" y="28" width="50" height="42" rx="7" {common}/>
          <path d="M23 39h50M32 34h14" {faint}/>
          <circle cx="18" cy="20" r="8" {common}/><circle cx="78" cy="20" r="8" {common}/>
          <path d="M18 28v9M78 28v9M34 53h18M34 61h27" {faint}/>
        """
        energy = f'<path d="M18 36 C26 43 29 45 36 47 M78 36 C70 43 67 45 60 47" {_stroke("url(#brand-gradient)", 3.2)}/>'
    elif spec.name == "multi-agent":
        hexes = "".join(
            f'<path d="M{x} {y-8} l7 4 v8 l-7 4 l-7-4 v-8z" {_stroke(primary, 2.5)}/>'
            for x, y in ((48, 17), (19, 69), (77, 69))
        )
        symbol = f"""
          <path d="M48 37 l12 7 v14 l-12 7 l-12-7V44z" {common}/>{hexes}
          <path d="M48 37V25M38 59L26 65M58 59l12 6" {faint}/>
          <circle cx="48" cy="51" r="4" fill="{primary}"/>
        """
        energy = f'<path d="M48 52V25M48 52L25 65M48 52l23 13" {_stroke("url(#brand-gradient)", 3.1)}/>'
    elif spec.name == "multi-device":
        symbol = f"""
          <rect x="9" y="25" width="34" height="24" rx="4" {common}/>
          <path d="M9 32h34M24 49v6h-8M32 49v6h8" {faint}/>
          <rect x="43" y="18" width="35" height="29" rx="4" {common}/>
          <path d="M43 25h35" {faint}/>
          <rect x="67" y="53" width="19" height="32" rx="5" {common}/>
          <path d="M73 59h7M75 79h3" {faint}/>
        """
        energy = f'<path d="M15 42 C34 72 48 67 55 46 C62 28 75 35 77 55" {_stroke("url(#brand-gradient)", 3.2)}/><circle cx="77" cy="55" r="3" fill="#FDE68A"/>'
    elif spec.name == "resource-routing":
        symbol = f"""
          <circle cx="48" cy="48" r="12" {common}/><circle cx="48" cy="48" r="4" fill="{primary}"/>
          <rect x="10" y="14" width="18" height="14" rx="3" {common}/>
          <path d="M15 19h8M15 24h5" {faint}/>
          <rect x="68" y="12" width="18" height="18" rx="3" {common}/><path d="M73 17h8v8h-8z" {faint}/>
          <rect x="8" y="70" width="22" height="14" rx="3" {common}/><path d="M13 75h12M13 80h7" {faint}/>
          <rect x="69" y="69" width="17" height="17" rx="4" {common}/><path d="M74 74h7v7h-7z" {faint}/>
          <path d="M39 39L28 28M57 39l11-11M39 57L30 70M57 57l12 12" {faint}/>
        """
        energy = f'<path d="M48 48L77 21M48 48L77 77" {_stroke("url(#brand-gradient)", 3.3)}/>'
    else:
        symbol = f"""
          <rect x="18" y="19" width="60" height="58" rx="10" {common}/>
          <path d="M18 31h60" {faint}/>
          <rect x="29" y="42" width="15" height="14" rx="3" {faint}/>
          <rect x="51" y="42" width="15" height="14" rx="3" {faint}/>
          <path d="M36 61v7M58 61v7M29 68h37" {faint}/>
          <path d="M69 10v16M61 18h16" {common}/>
        """
        energy = f'<path d="M69 10v16M61 18h16M69 27 C67 35 62 38 57 42" {_stroke("url(#brand-gradient)", 3.3)}/>'

    return (
        f'<g id="icon-structure"><g id="capability-symbol">{symbol}</g></g>'
        + _energy_group(spec, energy)
    )


def _person(spec: AssetSpec) -> str:
    primary = _paint(spec, active=False)
    secondary = _secondary(spec)
    person_styles = {
        "aya": ("#F3B89D", "#3B2757", "M27 45 C28 23 68 22 69 47 C61 35 48 33 37 39 C33 41 30 43 27 45"),
        "bo": ("#C98562", "#17213A", "M26 42 C29 20 65 21 70 42 C59 32 38 31 26 42"),
        "chen": ("#E4A986", "#252E55", "M28 44 C29 24 66 20 69 45 C57 38 44 38 28 44"),
        "dana": ("#8E5A45", "#0F766E", "M25 47 C23 24 69 19 71 47 C63 35 34 34 25 47"),
        "neutral": (secondary, secondary, "M28 43 C31 25 64 25 68 43"),
    }
    skin, hair, hair_path = person_styles[spec.name]
    features = "" if spec.name == "neutral" else (
        f'<path d="M39 50h2M55 50h2M43 59c3 3 7 3 10 0" {_stroke(primary, 1.8)}/>'
    )
    return f"""
      <g id="icon-structure">
        <g id="portrait">
          <circle cx="48" cy="48" r="39" fill="{_surface(spec)}" stroke="{primary}" stroke-width="3"/>
          <path d="M24 84 C27 69 35 63 48 63 C61 63 69 69 72 84" fill="{secondary}" opacity="0.82"/>
          <circle cx="48" cy="49" r="20" fill="{skin}"/>
          <path d="{hair_path}" fill="{hair}" opacity="0.96"/>
          {features}
          <path d="M17 63 A38 38 0 0 1 29 21" {_stroke("url(#brand-gradient)", 3.5, 0.9)}/>
        </g>
      </g>
      <g id="energy-trail" opacity="0"><circle cx="18" cy="62" r="3" fill="#22D3EE"/></g>
    """


def _agent(spec: AssetSpec) -> str:
    role, shape = spec.name.rsplit("-", 1)
    primary = _paint(spec, active=False)
    secondary = _secondary(spec)
    if shape == "hex":
        container = f'<path d="M48 8 L80 27 V69 L48 88 L16 69 V27 Z" fill="{_surface(spec)}" stroke="{primary}" stroke-width="3"/>'
    else:
        container = f'<rect x="10" y="10" width="76" height="76" rx="19" fill="{_surface(spec)}" stroke="{primary}" stroke-width="3"/>'

    symbols = {
        "spark": f'<path d="M48 24 L53 41 L69 31 L58 47 L75 52 L57 55 L63 73 L50 60 L39 75 L42 56 L23 53 L41 47 L30 31 L45 41 Z" {_stroke(primary, 2.8)}/>',
        "terminal": f'<path d="M28 35l14 13-14 13M48 62h21" {_stroke(primary, 4)}/>',
        "code": f'<path d="M37 30L23 48l14 18M59 30l14 18-14 18M54 24L42 72" {_stroke(primary, 3.5)}/>',
        "browser": f'<rect x="24" y="27" width="48" height="42" rx="5" {_stroke(primary, 3)}/><path d="M24 37h48M30 32h1M36 32h1M42 32h1M32 56l9-9 7 7 7-8 9 10" {_stroke(secondary, 2)}/>',
        "research": f'<circle cx="42" cy="43" r="15" {_stroke(primary, 3)}/><path d="M53 54l15 15M38 34h8M42 30v8M35 49h14" {_stroke(primary, 3)}/>',
        "planning": f'<rect x="26" y="23" width="44" height="52" rx="7" {_stroke(primary, 3)}/><path d="M36 37l4 4 7-8M36 52l4 4 7-8M52 38h9M52 53h9M36 66h25" {_stroke(secondary, 2.4)}/>',
    }
    return f"""
      <g id="icon-structure"><g id="agent-core">{container}{symbols[role]}</g></g>
      <g id="energy-trail" opacity="0"><path d="M20 76 C38 88 65 87 78 70" {_stroke("url(#brand-gradient)", 3)}/></g>
    """


def _state(spec: AssetSpec) -> str:
    primary = _paint(spec, active=False)
    secondary = _secondary(spec)
    color = {
        "default": secondary,
        "running": "url(#brand-gradient)",
        "complete": "#34D399",
        "error": "#FB7185",
    }[spec.state]
    marks = {
        "default": f'<circle cx="73" cy="73" r="5" fill="{color}"/>',
        "running": f'<path d="M73 63a10 10 0 1 1-8 4" {_stroke(color, 3.5)}/><circle cx="73" cy="63" r="2.5" fill="#FDE68A"/>',
        "complete": f'<path d="M66 73l5 5 10-12" {_stroke("#FFFFFF", 3.5)}/>',
        "error": f'<path d="M68 68l10 10M78 68L68 78" {_stroke("#FFFFFF", 3.5)}/>',
    }
    badge_fill = color if spec.state in {"complete", "error"} else _surface(spec)
    return f"""
      <g id="icon-structure">
        <circle cx="48" cy="48" r="34" {_stroke(primary, 3, 0.55)}/>
        <g id="state-indicator"><circle cx="73" cy="73" r="13" fill="{badge_fill}" stroke="{color}" stroke-width="2.5"/>{marks[spec.state]}</g>
      </g>
      <g id="energy-trail" opacity="{'1' if spec.state == 'running' else '0'}"><path d="M20 34 A34 34 0 0 1 72 20" {_stroke("url(#brand-gradient)", 3.2)}/></g>
    """


def _device(spec: AssetSpec) -> str:
    device, screen = spec.name.split("-", 1)
    primary = _paint(spec, active=False)
    secondary = _secondary(spec)
    surface = _surface(spec)
    sample = ""
    if screen == "sample":
        if device == "mobile":
            sample = f'<rect x="14" y="31" width="62" height="14" rx="4" fill="{secondary}" opacity="0.3"/><path d="M18 55h41M18 64h52M18 73h34M18 91h47M18 100h39M18 122h52" {_stroke(secondary, 2.2, 0.78)}/><circle cx="67" cy="56" r="4" fill="url(#brand-gradient)"/>'
        else:
            sample = f'<rect x="17" y="25" width="34" height="50" rx="4" fill="{secondary}" opacity="0.24"/><path d="M61 32h65M61 42h49M61 57h72M61 67h55" {_stroke(secondary, 2.2, 0.76)}/><rect x="61" y="78" width="31" height="11" rx="3" fill="url(#brand-gradient)" opacity="0.75"/>'

    if device == "web":
        frame = f'<rect x="5" y="7" width="150" height="86" rx="9" fill="{surface}" stroke="{primary}" stroke-width="3"/><path d="M5 20h150" {_stroke(primary, 2.5)}/><circle cx="14" cy="14" r="2" fill="#FB7185"/><circle cx="21" cy="14" r="2" fill="#FBBF24"/><circle cx="28" cy="14" r="2" fill="#34D399"/>'
    elif device == "pc":
        frame = f'<rect x="7" y="8" width="146" height="88" rx="10" fill="{surface}" stroke="{primary}" stroke-width="3"/><path d="M7 82h146M68 96v10M92 96v10M56 107h48" {_stroke(primary, 3)}/><circle cx="80" cy="89" r="2" fill="{secondary}"/>'
    else:
        frame = f'<rect x="6" y="4" width="78" height="152" rx="14" fill="{surface}" stroke="{primary}" stroke-width="3"/><path d="M34 13h22M39 147h12" {_stroke(primary, 2.5)}/>'

    return f"""
      <g id="icon-structure"><g id="device-screen">{frame}{sample}</g></g>
      <g id="energy-trail" opacity="0"><path d="M12 88 C48 102 112 102 148 82" {_stroke("url(#brand-gradient)", 3.2)}/></g>
    """


def _resource(spec: AssetSpec) -> str:
    primary = _paint(spec)
    secondary = _secondary(spec)
    common = _stroke(primary)
    faint = _stroke(secondary, 2, 0.78)
    symbols = {
        "foundation-model": f'<rect x="24" y="24" width="48" height="48" rx="10" {common}/><path d="M34 43c8-13 20-13 28 0M34 53c8 13 20 13 28 0M38 48h20" {faint}/><path d="M31 18v6M42 18v6M54 18v6M65 18v6M31 72v6M42 72v6M54 72v6M65 72v6" {faint}/>',
        "reasoning-model": f'<path d="M48 17 C30 17 22 29 24 43 C16 50 21 64 33 66 C37 77 54 80 62 70 C76 69 82 56 74 46 C80 30 66 16 48 17Z" {common}/><path d="M36 38c9-9 22-4 22 6 0 7-9 8-9 14M49 66h0" {faint}/>',
        "cloud-server": f'<path d="M28 62 C16 61 14 45 25 40 C25 25 45 19 55 31 C69 27 79 38 76 50 C86 57 79 69 68 69H30" {common}/><path d="M36 47h26M36 55h26M36 63h18" {faint}/>',
        "rack-server": f'<rect x="22" y="16" width="52" height="64" rx="6" {common}/><rect x="29" y="24" width="38" height="13" rx="3" {faint}/><rect x="29" y="42" width="38" height="13" rx="3" {faint}/><rect x="29" y="60" width="38" height="13" rx="3" {faint}/><circle cx="61" cy="30" r="2" fill="{primary}"/><circle cx="61" cy="48" r="2" fill="{primary}"/><circle cx="61" cy="66" r="2" fill="{primary}"/>',
        "gpu": f'<rect x="14" y="26" width="68" height="44" rx="6" {common}/><circle cx="44" cy="48" r="14" {faint}/><circle cx="44" cy="48" r="4" fill="{primary}"/><path d="M44 34v10M58 48H48M44 62V52M30 48h10M82 38h6M82 58h6M20 70v7M29 70v7M38 70v7" {faint}/>',
        "workstation": f'<rect x="13" y="18" width="50" height="38" rx="5" {common}/><path d="M13 49h50M31 56v8M45 56v8M25 64h26" {faint}/><rect x="68" y="24" width="16" height="49" rx="4" {common}/><circle cx="76" cy="64" r="2" fill="{primary}"/>',
        "local-pc": f'<rect x="16" y="19" width="64" height="45" rx="6" {common}/><path d="M16 54h64M39 64v9M57 64v9M31 74h34" {faint}/><path d="M33 35l9 8-9 8M48 51h14" {_stroke(primary, 2.8)}/>',
        "browser-test": f'<rect x="12" y="18" width="72" height="59" rx="7" {common}/><path d="M12 30h72M20 24h1M27 24h1M34 24h1" {faint}/><path d="M28 55l9 9 29-29" {_stroke(primary, 4)}/>',
    }
    energy = f'<path d="M21 75 C33 86 68 86 78 70" {_stroke("url(#brand-gradient)", 3.2)}/><circle cx="78" cy="70" r="3" fill="#FDE68A"/>'
    return f'<g id="icon-structure"><g id="resource-symbol">{symbols[spec.name]}</g></g>{_energy_group(spec, energy)}'


def _relation(spec: AssetSpec) -> str:
    primary = _paint(spec, active=False)
    secondary = _secondary(spec)
    if spec.name == "connection":
        symbol = f'<circle cx="22" cy="48" r="8" {_stroke(primary, 3)}/><circle cx="138" cy="48" r="8" {_stroke(primary, 3)}/><path d="M30 48H130" {_stroke(secondary, 2.5)}/>'
    elif spec.name == "traveler":
        symbol = f'<path d="M15 65 C48 10 102 86 145 31" {_stroke(secondary, 3)}/><circle cx="91" cy="56" r="6" fill="url(#brand-gradient)" filter="url(#soft-glow)"/>'
    elif spec.name == "task-card":
        symbol = f'<rect x="25" y="17" width="110" height="62" rx="11" fill="{_surface(spec)}" stroke="{primary}" stroke-width="3"/><circle cx="43" cy="36" r="7" fill="url(#brand-gradient)"/><path d="M58 32h52M58 41h37M40 58h74M40 67h49" {_stroke(secondary, 2.5)}/>'
    elif spec.name == "status-label":
        symbol = f'<rect x="35" y="31" width="90" height="34" rx="17" fill="{_surface(spec)}" stroke="{primary}" stroke-width="3"/><circle cx="54" cy="48" r="6" fill="#34D399"/><path d="M70 43h35M70 52h25" {_stroke(secondary, 2.5)}/>'
    else:
        symbol = f'<circle cx="18" cy="48" r="7" {_stroke(primary, 3)}/><circle cx="80" cy="18" r="7" {_stroke(primary, 3)}/><circle cx="142" cy="48" r="7" {_stroke(primary, 3)}/><circle cx="80" cy="78" r="7" {_stroke(primary, 3)}/><path d="M25 48 C47 48 48 18 73 18M87 18 C112 18 113 48 135 48M25 48 C47 48 48 78 73 78M87 78 C112 78 113 48 135 48" {_stroke(secondary, 2.5)}/>'
    return f"""
      <g id="icon-structure"><g id="relation-path">{symbol}</g></g>
      <g id="energy-trail" opacity="0"><path d="M20 48 C60 8 100 88 140 48" {_stroke("url(#brand-gradient)", 3.2)}/></g>
    """


CATEGORY_RENDERERS = {
    "logo": _logo,
    "capabilities": _capability,
    "people": _person,
    "agents": _agent,
    "states": _state,
    "devices": _device,
    "resources": _resource,
    "relations": _relation,
}


def render_svg(spec: AssetSpec) -> str:
    return _svg_document(spec, CATEGORY_RENDERERS[spec.category](spec))
