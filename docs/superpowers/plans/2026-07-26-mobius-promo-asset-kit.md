# Mobius Promo Asset Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete, editable Mobius promotional-video asset kit with SVG sources, transparent PNG exports, preview boards, a manifest, and usage guidance.

**Architecture:** A small Python asset generator owns the shared palette, SVG primitives, category-specific artwork, PNG rasterization, manifest creation, and preview-board composition. Generated deliverables live under one self-contained asset directory; `unittest` validates inventory, XML structure, semantic layer IDs, dimensions, alpha channels, and manifest consistency.

**Tech Stack:** Python 3 standard library, CairoSVG 2.9, Pillow 12.2, SVG 1.1, JSON, `unittest`.

## Global Constraints

- Use the approved “system linework + brand energy trail” visual direction.
- Produce both dark-theme and light-theme variants.
- Preserve the Mobius animation palette: `#22D3EE`, `#7DD3FC`, `#8B5CF6`, `#A78BFA`, `#EC4899`, `#F472B6`.
- Keep SVG backgrounds transparent and use semantic group IDs for animation.
- Do not introduce robot-head, emoji, 3D skeuomorphic, wrench, or hammer iconography.
- Export icons at 1024px, device frames with a 2160px long edge, and the hero Logo at up to 4096px wide.
- Do not modify the existing `mobius-ring-standalone.html` animation.

---

### Task 1: Define and test the asset inventory contract

**Files:**
- Create: `docs/superpowers/assets/mobius-promo-kit/scripts/asset_system.py`
- Create: `docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py`

**Interfaces:**
- Produces: `AssetSpec`, `THEMES`, `BRAND_COLORS`, `build_inventory()`, and `validate_inventory()`.
- Consumes: only Python standard-library types.

- [ ] **Step 1: Write the failing inventory tests**

```python
def test_inventory_contains_all_required_categories(self):
    inventory = build_inventory()
    self.assertEqual(
        {item.category for item in inventory},
        {"logo", "capabilities", "people", "agents", "states", "devices", "resources", "relations"},
    )

def test_capabilities_cover_seven_concepts_in_two_states_and_themes(self):
    items = [item for item in build_inventory() if item.category == "capabilities"]
    self.assertEqual(len(items), 7 * 2 * 2)
```

- [ ] **Step 2: Run tests and verify the RED state**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: FAIL because `asset_system` and `build_inventory()` do not exist.

- [ ] **Step 3: Implement the typed inventory model and exact category matrix**

```python
@dataclass(frozen=True)
class AssetSpec:
    category: str
    name: str
    theme: str
    state: str
    width: int
    height: int

def build_inventory() -> list[AssetSpec]:
    specs: list[AssetSpec] = []
    # Expand the explicit logo, capability, people, agent, state,
    # device, resource, and relationship matrices from the design spec.
    return specs
```

- [ ] **Step 4: Run the inventory tests**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: all inventory tests PASS.

### Task 2: Generate valid layered SVG artwork

**Files:**
- Modify: `docs/superpowers/assets/mobius-promo-kit/scripts/asset_system.py`
- Modify: `docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py`

**Interfaces:**
- Consumes: `AssetSpec`, `THEMES`, `BRAND_COLORS`.
- Produces: `render_svg(spec: AssetSpec) -> str` and category renderers with stable IDs.

- [ ] **Step 1: Add failing SVG contract tests**

```python
def test_every_asset_renders_parseable_transparent_svg(self):
    for spec in build_inventory():
        root = ElementTree.fromstring(render_svg(spec))
        self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
        self.assertIn("viewBox", root.attrib)
        self.assertNotIn("background", root.attrib)

def test_active_assets_define_brand_gradient_and_semantic_layers(self):
    active = next(item for item in build_inventory() if item.state == "active")
    svg = render_svg(active)
    self.assertIn('id="brand-gradient"', svg)
    self.assertIn('id="icon-structure"', svg)
    self.assertIn('id="energy-trail"', svg)
```

- [ ] **Step 2: Run the SVG tests and verify they fail**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: FAIL because `render_svg()` is missing.

- [ ] **Step 3: Implement shared SVG primitives and all category renderers**

```python
def render_svg(spec: AssetSpec) -> str:
    body = CATEGORY_RENDERERS[spec.category](spec)
    return svg_document(spec, body)

CATEGORY_RENDERERS = {
    "logo": render_logo,
    "capabilities": render_capability,
    "people": render_person,
    "agents": render_agent,
    "states": render_state,
    "devices": render_device,
    "resources": render_resource,
    "relations": render_relation,
}
```

Each renderer must draw its approved concept from the design document, reuse rounded strokes, and expose `icon-structure`, `energy-trail`, and category-specific semantic groups.

- [ ] **Step 4: Run tests and verify all SVG contracts pass**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: all tests PASS.

### Task 3: Export SVG, transparent PNG, and manifest files

**Files:**
- Create: `docs/superpowers/assets/mobius-promo-kit/scripts/generate_assets.py`
- Modify: `docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py`
- Generate: `docs/superpowers/assets/mobius-promo-kit/{01-logo,02-capabilities,03-people-agents,04-device-frames,05-compute-resources,06-motion-guides}/**/*`
- Generate: `docs/superpowers/assets/mobius-promo-kit/manifest.json`

**Interfaces:**
- Consumes: `build_inventory()` and `render_svg()`.
- Produces: `generate_all(output_root: Path) -> list[dict[str, object]]`.

- [ ] **Step 1: Add failing export tests**

```python
def test_generate_all_writes_svg_png_and_consistent_manifest(self):
    with TemporaryDirectory() as tmp:
        records = generate_all(Path(tmp))
        self.assertTrue(records)
        for record in records:
            self.assertTrue((Path(tmp) / record["svg"]).is_file())
            self.assertTrue((Path(tmp) / record["png"]).is_file())
        self.assertEqual(records, json.loads((Path(tmp) / "manifest.json").read_text())["assets"])
```

- [ ] **Step 2: Run export tests and verify they fail**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: FAIL because `generate_all()` is missing.

- [ ] **Step 3: Implement deterministic export and rasterization**

```python
def generate_all(output_root: Path) -> list[dict[str, object]]:
    records = []
    for spec in build_inventory():
        svg = render_svg(spec)
        svg_path, png_path = output_paths(output_root, spec)
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        svg_path.write_text(svg, encoding="utf-8")
        cairosvg.svg2png(bytestring=svg.encode(), write_to=str(png_path),
                         output_width=spec.width, output_height=spec.height)
        records.append(manifest_record(output_root, spec, svg_path, png_path))
    write_manifest(output_root, records)
    return records
```

- [ ] **Step 4: Run tests and generate the production asset tree**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: all tests PASS.
Run: `python3 docs/superpowers/assets/mobius-promo-kit/scripts/generate_assets.py`
Expected: exits 0 and prints category and total counts.

### Task 4: Build preview boards and usage documentation

**Files:**
- Modify: `docs/superpowers/assets/mobius-promo-kit/scripts/generate_assets.py`
- Modify: `docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py`
- Generate: `docs/superpowers/assets/mobius-promo-kit/00-preview/*.png`
- Create: `docs/superpowers/assets/mobius-promo-kit/README.md`
- Create: `docs/superpowers/assets/mobius-promo-kit/06-motion-guides/animation-guide.md`

**Interfaces:**
- Consumes: generated transparent PNGs and manifest records.
- Produces: `build_preview_boards(output_root, records) -> list[Path]` and human-readable guidance.

- [ ] **Step 1: Add failing preview validation tests**

```python
def test_preview_boards_are_4k_rgb_images(self):
    with TemporaryDirectory() as tmp:
        records = generate_all(Path(tmp))
        boards = build_preview_boards(Path(tmp), records)
        self.assertGreaterEqual(len(boards), 2)
        for path in boards:
            with Image.open(path) as image:
                self.assertEqual(image.size, (3840, 2160))
                self.assertIn(image.mode, {"RGB", "RGBA"})
```

- [ ] **Step 2: Run preview tests and verify they fail**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: FAIL because preview-board creation is missing.

- [ ] **Step 3: Implement 4K overview and category boards, then write usage guidance**

Preview boards must show file labels, theme contrast, default/active comparisons, and safe margins. `README.md` must document folder layout, naming, import into After Effects/Figma/Premiere/剪映, and reuse rules. `animation-guide.md` must map the semantic SVG group IDs to reveal, traveler, node activation, device handoff, and resource-routing keyframes.

- [ ] **Step 4: Run tests and regenerate the complete kit**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: all tests PASS.
Run: `python3 docs/superpowers/assets/mobius-promo-kit/scripts/generate_assets.py`
Expected: exits 0 and writes all preview boards.

### Task 5: Perform structural and visual verification

**Files:**
- Modify if needed: generated files under `docs/superpowers/assets/mobius-promo-kit/`

**Interfaces:**
- Consumes: the complete generated kit.
- Produces: verification evidence only; no new public interface.

- [ ] **Step 1: Run the full automated validator**

Run: `python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v`
Expected: zero failures and zero errors.

- [ ] **Step 2: Validate every generated SVG and PNG independently**

Run: `python3 docs/superpowers/assets/mobius-promo-kit/scripts/generate_assets.py --check`
Expected: reports all manifest files present, SVG XML parseable, PNG dimensions correct, alpha channels present, and no stale files.

- [ ] **Step 3: Inspect both 4K overview boards**

Open the dark and light overview PNGs and check Logo shape, icon recognizability, contrast, clipping, spacing, and consistency. Regenerate after any correction.

- [ ] **Step 4: Review the requirement checklist and working-tree diff**

Run: `git status --short && git diff --stat && git diff --check`
Expected: only the design, plan, asset kit, generator, tests, previews, and documentation are changed; `git diff --check` exits 0.
