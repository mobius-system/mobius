# Video Cover Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `video-cover` extension into a real async video cover generator with uploads, platform/ratio controls, AI text and exact-text modes, preview, download, retry, and history.

**Architecture:** Keep the extension zero-build and use native browser ESM on the frontend. The backend handler remains stateless and fast: it validates requests, persists job metadata under `ext_data_dir`, and spawns `cover_worker.js` for long-running generation. The worker owns image generation, quality validation, optional PIL text overlay, and per-ratio result updates.

**Tech Stack:** CommonJS Node handler and worker, native browser ESM, existing `/extension/_sdk/ext.js` `extCall/extUpload`, nano-banana-compatible image generation config, ffmpeg for image validation, optional Python/PIL for exact text overlay.

## Global Constraints

- Work in `mobius/extension/video-cover`; do not modify the platform upload route for the first version.
- Do not implement video intro composition or output mp4 files.
- Use `/api/extensions/video-cover/upload` through `extUpload` for video and reference image uploads.
- Handler actions must return within the extension 30 second request limit.
- Handler JSON responses must stay below 5MB; `get_asset` returns one PNG only and rejects files over 4MB.
- All extension data writes must stay under `ext_data_dir`.
- Use AI text mode by default; exact text mode generates a no-text background and overlays Chinese text with local fonts.
- Quality validation must reject blank, solid-color, or undecodable output images.
- No new frontend build step.

---

## File Structure

- Modify `mobius/extension/video-cover/backend/extension_backend_handler.js`: action routing, state/job persistence, validation, process spawning, `get_asset`.
- Create `mobius/extension/video-cover/backend/cover_worker.js`: long-running per-ratio generation, prompt building, image API calls, validation, exact-text overlay dispatch, job status updates.
- Create `mobius/extension/video-cover/backend/cover_core.js`: pure helper functions shared by handler, worker, and tests.
- Create `mobius/extension/video-cover/tests/backend_core.test.js`: Node tests for validation, prompt planning, safe paths, status shaping, and asset limits.
- Modify `mobius/extension/video-cover/frontend/index.html`: real workbench structure.
- Modify `mobius/extension/video-cover/frontend/main.js`: upload, job creation, polling, asset loading, retry, delete, rendering.
- Modify `mobius/extension/video-cover/frontend/styles.css`: responsive workbench visual design.
- Modify `mobius/extension/video-cover/extension.json`: add icon and sharpen description if needed.

## Design System Direction

Subject: a production workbench for creators making platform-specific video covers.

Palette:

- `ink`: `#14130f`
- `paper`: `#fbf7ef`
- `carmine`: `#d83b5b`
- `marigold`: `#ffb000`
- `cyan`: `#14b8c4`
- `graphite`: `#312f2b`

Type:

- Use system Chinese sans fonts for reliability.
- Use compact utility labels and restrained headings; this is a workbench, not a hero site.

Layout:

```text
┌──────────────────────────────────────────────────────────┐
│ top rail: title, config state, refresh                   │
├─────────────────────────────┬────────────────────────────┤
│ input controls              │ current job preview        │
│ uploads / copy / platform   │ result cards per ratio     │
│ ratios / text mode          │ history strip              │
└─────────────────────────────┴────────────────────────────┘
```

Signature element: a “ratio rail” where each requested output ratio has a stable frame silhouette and status chip. It is specific to cover production and gives users immediate confidence that horizontal and vertical outputs are separate deliverables.

## Task 1: Backend Core Helpers

**Files:**
- Create: `mobius/extension/video-cover/backend/cover_core.js`
- Create: `mobius/extension/video-cover/tests/backend_core.test.js`

**Interfaces:**
- Produces:
  - `PLATFORMS: string[]`
  - `RATIOS: Record<string, { id, label, aspectRatio, imageApiAspect, width, height }>`
  - `TEXT_MODES: string[]`
  - `sanitizeUserSegment(value: unknown): string`
  - `createJobId(now?: number, random?: string): string`
  - `normalizeCreatePayload(payload: object): object`
  - `buildGenerationPlan(job: object): object[]`
  - `shapeJobForClient(job: object): object`
  - `isAssetUnderLimit(size: number): boolean`

- [ ] **Step 1: Write failing tests**

Create tests covering:

```js
const assert = require('assert');
const core = require('../backend/cover_core');

assert.deepStrictEqual(
  core.normalizeCreatePayload({
    title: '  管不动 AI？  ',
    subtitle: '莫比乌斯封面',
    platform: 'xiaohongshu',
    ratios: ['16x9', '3x4'],
    text_mode: 'exact',
    notes: '亮色',
  }).ratios,
  ['16x9', '3x4'],
);

assert.throws(() => core.normalizeCreatePayload({ title: '', platform: 'bad', ratios: [] }), /主标题/);
assert.strictEqual(core.isAssetUnderLimit(4 * 1024 * 1024), true);
assert.strictEqual(core.isAssetUnderLimit(4 * 1024 * 1024 + 1), false);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node mobius/extension/video-cover/tests/backend_core.test.js`

Expected: failure because `cover_core.js` does not exist.

- [ ] **Step 3: Implement helpers**

Implement constants, validation, job shaping, ratio metadata, and file-size guard. Keep helpers pure and synchronous.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node mobius/extension/video-cover/tests/backend_core.test.js`

Expected: exit code `0`.

## Task 2: Handler State, Uploads, Jobs, Assets

**Files:**
- Modify: `mobius/extension/video-cover/backend/extension_backend_handler.js`
- Modify: `mobius/extension/video-cover/tests/backend_core.test.js`

**Interfaces:**
- Consumes: helpers from `cover_core.js`.
- Produces handler actions: `get_state`, `register_upload`, `create_job`, `get_job`, `list_jobs`, `retry_item`, `delete_job`, `get_asset`.

- [ ] **Step 1: Write failing tests**

Extend tests to create a temp `ext_data_dir`, call the handler directly, and assert:

```js
const handler = require('../backend/extension_backend_handler');
const res = await handler({
  username: 'tester',
  display_name: '测试',
  ext_main_payload: { action: 'get_state' },
  ext_data_dir: tmp,
  extension_name: 'video-cover',
  logger: console,
});
assert.strictEqual(res.ok, true);
assert.ok(Array.isArray(res.jobs));
```

Also test that `create_job` rejects empty title and that `get_asset` rejects files over 4MB.

- [ ] **Step 2: Run tests and verify RED**

Run: `node mobius/extension/video-cover/tests/backend_core.test.js`

Expected: failures because the handler still has note-only behavior.

- [ ] **Step 3: Implement handler**

Replace note actions with real action routing. Persist state under `users/<safeUser>/state.json`, jobs under `users/<safeUser>/jobs/<jobId>`, and spawn `cover_worker.js` detached for `create_job`/`retry_item`. If `process.env.VIDEO_COVER_SYNC_WORKER === '1'`, run the worker inline for tests and local debugging.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node mobius/extension/video-cover/tests/backend_core.test.js`

Expected: exit code `0`.

## Task 3: Worker Generation Pipeline

**Files:**
- Create: `mobius/extension/video-cover/backend/cover_worker.js`
- Modify: `mobius/extension/video-cover/tests/backend_core.test.js`

**Interfaces:**
- Consumes: job directory containing `job.json` and `inputs.json`.
- Produces: per-ratio PNG files and updated `job.json`.

- [ ] **Step 1: Write failing tests**

Add a test that creates a fake job with `mock://success` image config and asserts the worker writes a valid PNG result file and marks the item `done`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node mobius/extension/video-cover/tests/backend_core.test.js`

Expected: worker module missing or unsupported mock config.

- [ ] **Step 3: Implement worker**

Implement:

- `runWorker({ jobDir, extDataDir, username })`
- image config loading from env or `mobius-auto-recording/cover_config.json`
- `mock://success` test provider that writes a deterministic PNG
- real provider POST to `/v1/images/generations`
- ffmpeg-based quality validation
- exact-text mode using local Python script when available, with fallback to generated image if overlay fails
- status updates after every ratio

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node mobius/extension/video-cover/tests/backend_core.test.js`

Expected: exit code `0`.

## Task 4: Frontend Workbench

**Files:**
- Modify: `mobius/extension/video-cover/frontend/index.html`
- Modify: `mobius/extension/video-cover/frontend/main.js`
- Modify: `mobius/extension/video-cover/frontend/styles.css`

**Interfaces:**
- Consumes: handler actions from Task 2.
- Produces: usable workbench with uploads, form, polling, preview, download, retry, delete, history.

- [ ] **Step 1: Add frontend smoke checks**

Run after implementation with browser and manual checks. Because this extension has no frontend unit harness, verification is Playwright/browser based.

- [ ] **Step 2: Implement HTML structure**

Replace the scaffold note UI with top rail, upload sections, form controls, result grid, and history panel.

- [ ] **Step 3: Implement frontend state and actions**

Use `extCall` and `extUpload`. Add polling with cleanup, `data_url` to blob download, result-card asset loading, and form validation.

- [ ] **Step 4: Implement CSS**

Apply the design system above. Keep all card radii at 8px or less. Use stable aspect-ratio frames for all previews.

- [ ] **Step 5: Run syntax checks**

Run:

```bash
node --check mobius/extension/video-cover/frontend/main.js
node --check mobius/extension/video-cover/backend/extension_backend_handler.js
node --check mobius/extension/video-cover/backend/cover_worker.js
node --check mobius/extension/video-cover/backend/cover_core.js
```

Expected: all exit code `0`.

## Task 5: End-to-End Verification

**Files:**
- No source changes unless verification exposes issues.

**Interfaces:**
- Consumes complete extension.
- Produces evidence that the feature works.

- [ ] **Step 1: Run backend tests**

Run: `node mobius/extension/video-cover/tests/backend_core.test.js`

Expected: exit code `0`.

- [ ] **Step 2: Rebuild/reload extension if server is running**

Use existing Mobius extension rebuild/reload commands only if a local server is active. Otherwise report that browser verification was not run.

- [ ] **Step 3: Run real or mock generation**

If real image config exists, create one `16x9` and one vertical cover through the UI or handler. If real config is unavailable or slow, run mock worker verification and clearly report that real image generation was not exercised.

- [ ] **Step 4: Show generated images**

Use `display_images` with absolute paths for generated PNGs when available.

- [ ] **Step 5: Final status**

Run `git status --short`, summarize changed files, and remove `/home/tianyi/imac-test/.imac/flags/67856f7d/running.flag` only after all work is complete or definitively failed.
