# Mobius Promotional Video Production Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a polished 16:9 Chinese Mobius promotional video, approximately 4 minutes 20 seconds long, and deliver a verified H.264 MP4 that follows the approved V3 storyboard.

**Architecture:** Build the video as a reproducible artifact pipeline under `.imac/generated_videos/71f6091f/`. Three independent workers prepare narration, official/existing media, and fresh Mobius UI recordings; the primary worker then normalizes those assets, renders motion titles and subtitles, assembles the master timeline, mixes audio, and performs visual and decode verification.

**Tech Stack:** Playwright/Chromium, Node.js 22 fetch API, Doubao TTS through the local Mobius API, Python 3, FFmpeg 7 with libx264/libass, existing Mobius self-evolution footage, official README media assets.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-07-25-mobius-promo-video-design.md` V3.
- Final positioning: `Mobius，塑造属于你的 Agent OS。`
- Product definition: `一个由用户持续塑造、随需求不断进化的智能体操作系统。`
- Project/team collaboration is a supported scenario, not the first-level product definition.
- Final output: `.imac/generated_videos/71f6091f/mobius-agent-os-promo-v1.mp4`.
- Master format: 1920×1080, 30 fps, H.264 High Profile, `yuv420p`, AAC 48 kHz stereo, `+faststart`.
- Target duration: 240–280 seconds; editorial target is 260 seconds.
- Use only real Mobius UI, official Mobius README media, or clearly typographic/motion-graphic bridge shots.
- Do not portray Claude Code, Codex, or Claw products as chat-only tools; acknowledge that current Agents can execute real work.
- Do not show Tokens, passwords, IP addresses, internal URLs, private customer data, or personal notifications.
- Do not mutate or delete existing user projects while recording. Use read-only navigation and existing demo content.
- Keep all raw recordings, intermediate files, scripts, manifests, checks, and the final MP4 under `.imac/generated_videos/71f6091f/`.
- Do not use a git worktree; this production uses the current workspace and artifact-only output paths.
- Do not delete `running.flag` until the final MP4, decode check, frame review, and handoff are complete.

---

## File and Artifact Map

- `docs/superpowers/specs/2026-07-25-mobius-promo-video-design.md`: approved narrative and storyboard.
- `.imac/generated_videos/71f6091f/production/shot-manifest.json`: ordered shot definitions, durations, copy, and asset paths.
- `.imac/generated_videos/71f6091f/production/narration-segments.json`: exact narration split by shot.
- `.imac/generated_videos/71f6091f/production/generate-narration.mjs`: authenticates locally and generates narration without printing the token.
- `.imac/generated_videos/71f6091f/production/record-ui.mjs`: records safe, read-only Mobius UI clips with Playwright.
- `.imac/generated_videos/71f6091f/production/fetch-official-assets.mjs`: downloads the official README media used in the film.
- `.imac/generated_videos/71f6091f/production/render-promo.py`: normalizes clips, creates title cards/subtitles, assembles the timeline, and mixes audio.
- `.imac/generated_videos/71f6091f/raw/voice/`: one MP3 per narration segment.
- `.imac/generated_videos/71f6091f/raw/ui/`: fresh Playwright WebM recordings and screenshots.
- `.imac/generated_videos/71f6091f/raw/official/`: downloaded Mobius official GIF/JPG/PNG assets.
- `.imac/generated_videos/71f6091f/raw/existing/`: normalized excerpts from existing self-evolution video and generated BGM.
- `.imac/generated_videos/71f6091f/work/`: normalized 1080p clips, ASS files, concat manifests, and temporary audio.
- `.imac/generated_videos/71f6091f/checks/`: contact sheets and sampled frames at editorial checkpoints.
- `.imac/generated_videos/71f6091f/mobius-agent-os-promo-v1.mp4`: final deliverable.

### Task 1: Create the production manifest and deterministic workspace

**Files:**
- Create: `.imac/generated_videos/71f6091f/production/shot-manifest.json`
- Create: `.imac/generated_videos/71f6091f/production/narration-segments.json`
- Create: `.imac/generated_videos/71f6091f/production/validate-manifest.mjs`

**Interfaces:**
- Consumes: V3 storyboard and the global constraints above.
- Produces: `shots: Array<{id,title,targetSeconds,sourceKind,sourcePath,headline,narrationId}>` and `segments: Array<{id,text,voice}>` used by all later tasks.

- [ ] **Step 1: Create artifact directories**

Run:

```bash
mkdir -p .imac/generated_videos/71f6091f/{production,raw/voice,raw/ui,raw/official,raw/existing,work,checks}
```

Expected: all seven directories exist and no existing generated-video directory is removed.

- [ ] **Step 2: Encode the 14-shot V3 timeline**

Create `shot-manifest.json` with these exact target durations in seconds:

```json
[
  ["01-agent-capability",12],
  ["02-user-shaped-question",13],
  ["03-mobius-reveal",18],
  ["04-self-evolution",19],
  ["05-project-entry",22],
  ["06-first-task-git",20],
  ["07-files-git",19],
  ["08-task-network",20],
  ["09-live-frontend",21],
  ["10-playwright-loop",23],
  ["11-remote-compute",20],
  ["12-research",20],
  ["13-xiaomo-mobile",20],
  ["14-brand-close",13]
]
```

The durations must sum to 260 seconds. Use `sourceKind` values only from `motion`, `playwright`, `official`, and `existing`.

- [ ] **Step 3: Encode narration exactly as approved**

Create `narration-segments.json` by copying the 14 paragraphs from section 7 of the V3 spec in order. Set every `voice` to `zh_female_vv_uranus_bigtts` so the first render has a consistent, natural Mandarin product voice.

- [ ] **Step 4: Write and run manifest validation**

`validate-manifest.mjs` must assert: 14 shots, 14 unique IDs, total target duration 260, every `narrationId` exists, no empty headline, no occurrence of `AI 不应停在对话框里`, and the final headline equals `Mobius，塑造属于你的 Agent OS`.

Run:

```bash
node .imac/generated_videos/71f6091f/production/validate-manifest.mjs
```

Expected: `manifest: ok shots=14 duration=260 narration=14`.

- [ ] **Step 5: Record a workspace checksum**

Run:

```bash
sha256sum .imac/generated_videos/71f6091f/production/shot-manifest.json .imac/generated_videos/71f6091f/production/narration-segments.json > .imac/generated_videos/71f6091f/production/manifests.sha256
```

Expected: two checksum lines.

### Task 2: Generate and verify Chinese narration

**Files:**
- Create: `.imac/generated_videos/71f6091f/production/generate-narration.mjs`
- Create: `.imac/generated_videos/71f6091f/raw/voice/01-agent-capability.mp3` through `14-brand-close.mp3`
- Create: `.imac/generated_videos/71f6091f/raw/voice/voice-report.json`

**Interfaces:**
- Consumes: `narration-segments.json`, local Mobius API at `http://localhost:45616`, username `admin` with passwordless local login.
- Produces: one non-empty MP3 per narration ID and a report containing byte size and decoded duration for every segment.

- [ ] **Step 1: Verify TTS availability without exposing credentials**

`generate-narration.mjs` must authenticate with `POST /api/auth/login`, keep the token only in memory, then call `GET /api/assistant/tts/voices`. It must fail with a clear message unless `configured === true` and the selected voice is present. It must never print the token or response authorization headers.

- [ ] **Step 2: Generate one MP3 per narration paragraph**

For each segment, call `POST /api/assistant/speak` with JSON `{text, voice}` and write the response bytes to `raw/voice/<id>.mp3`. Retry network or provider errors at most twice with 1-second and 2-second backoff; do not retry authentication errors.

- [ ] **Step 3: Decode-check every voice segment**

For each MP3 run:

```bash
ffmpeg -v error -i <segment.mp3> -f null -
```

Expected: exit code 0 for all 14 files.

- [ ] **Step 4: Produce a voice report**

Use FFmpeg stderr duration parsing to write `voice-report.json` with `{id,bytes,durationSeconds}` for all segments. Assert each duration is greater than 2 seconds and less than its shot target duration minus 0.5 seconds. If one paragraph exceeds its target, regenerate it with punctuation tightened only as allowed by the V3 copy, or use FFmpeg `atempo` within 0.95–1.08; never exceed 1.08.

- [ ] **Step 5: Render and inspect a 15-second voice sample**

Join the first two segments with 500 ms of silence into `checks/voice-sample.mp3` and decode-check it. This is the first audible quality gate before the master render.

### Task 3: Prepare official and existing media

**Files:**
- Create: `.imac/generated_videos/71f6091f/production/fetch-official-assets.mjs`
- Create: `.imac/generated_videos/71f6091f/raw/official/*`
- Create: `.imac/generated_videos/71f6091f/raw/existing/self-evolution-source.mp4`
- Create: `.imac/generated_videos/71f6091f/raw/existing/bgm.mp3`
- Create: `.imac/generated_videos/71f6091f/checks/source-contact-sheet.png`

**Interfaces:**
- Consumes: official media URLs from `README.zh.md`, existing self-evolution video, existing 144.12-second MiniMax BGM.
- Produces: decoded, checksum-recorded source assets for the editor.

- [ ] **Step 1: Copy the proven self-evolution sources**

Copy without deleting originals:

```bash
cp .imac/generated_videos/self-evo-809f3982-948b5fed/self-evolution-demo.mp4 .imac/generated_videos/71f6091f/raw/existing/self-evolution-source.mp4
cp .imac/generated_videos/self-evo-809f3982-948b5fed/bgm.mp3 .imac/generated_videos/71f6091f/raw/existing/bgm.mp3
```

- [ ] **Step 2: Download only the approved official assets**

`fetch-official-assets.mjs` must download these URLs and reject non-2xx or zero-byte responses:

```text
https://serve.nutshellai.cn/publish/auto/readme/github-cover-v1.png
https://serve.nutshellai.cn/publish/auto/readme/can-do-agent-os.gif
https://serve.nutshellai.cn/publish/auto/readme/can-do-research.gif
https://serve.nutshellai.cn/publish/auto/readme/xiaomo.jpg
https://serve.nutshellai.cn/publish/auto/readme/xiaomo-app.jpg
https://serve.nutshellai.cn/publish/auto/readme/xiaomo-desktop-v2.png
https://serve.nutshellai.cn/publish/auto/readme/can-do-team-collab.gif
https://serve.nutshellai.cn/publish/auto/readme/can-do-extensions.gif
```

- [ ] **Step 3: Decode-check every source asset**

Run FFmpeg with `-v error -f null -` for the MP4, MP3, and GIF files; use FFmpeg single-frame decode for PNG/JPG files. Expected: every source decodes with exit code 0.

- [ ] **Step 4: Create a source contact sheet**

Extract representative frames from the self-evolution source, both official GIFs, and all three XiaoMo device images. Tile them into `checks/source-contact-sheet.png` at 1920×1080 for visual review.

- [ ] **Step 5: Record source checksums**

Run `sha256sum` over `raw/official/*` and `raw/existing/*`, saving the result to `production/source-assets.sha256`.

### Task 4: Record fresh, safe Mobius UI footage

**Files:**
- Create: `.imac/generated_videos/71f6091f/production/record-ui.mjs`
- Create: `.imac/generated_videos/71f6091f/raw/ui/03-mobius-reveal.webm`
- Create: `.imac/generated_videos/71f6091f/raw/ui/05-project-entry.webm`
- Create: `.imac/generated_videos/71f6091f/raw/ui/06-first-task-git.webm`
- Create: `.imac/generated_videos/71f6091f/raw/ui/07-files-git.webm`
- Create: `.imac/generated_videos/71f6091f/raw/ui/08-task-network.webm`
- Create: `.imac/generated_videos/71f6091f/raw/ui/09-live-frontend.webm`
- Create: `.imac/generated_videos/71f6091f/raw/ui/12-research.webm`
- Create: `.imac/generated_videos/71f6091f/raw/ui/13-xiaomo-mobile.webm`
- Create: `.imac/generated_videos/71f6091f/checks/ui-contact-sheet.png`

**Interfaces:**
- Consumes: local Mobius service at port 45616, passwordless `admin` login, existing project `9a533442` (`imac-self-develop`), existing project `f3c99d5c` (`周末小聚邀请页案例`), existing XiaoMo project `xm-d033e22ae3`.
- Produces: eight 1440×900 Playwright WebM clips with no project mutations and representative screenshots.

- [ ] **Step 1: Load the Playwright production rules**

Read `.imac/skills/playwright-skill/SKILL.md` completely. Use headless Chromium and a 1440×900 viewport. Store the JWT only in browser localStorage and process memory; never write it to an artifact or log.

- [ ] **Step 2: Implement deterministic recording helpers**

`record-ui.mjs` must expose `login()`, `newRecordedContext(name)`, `openSafe(route)`, `movePointer(points)`, and `finishClip(context, video, output)`. Set `cc-token`, disable background flow animation if supported, hide notifications, and wait for two stable animation frames before each recorded action.

- [ ] **Step 3: Record product reveal and project entry**

Record the home/project transition and the `imac-self-develop` project overview. Use slow pointer movement and a 1.5-second hold on the project card and project header. For project entry, show the existing project/workspace controls without selecting a new directory or uploading a file.

- [ ] **Step 4: Record first-task, files/Git, and task-network footage**

Use read-only tabs in project `9a533442` and invitation demo project `f3c99d5c`. Show an existing first task, project/Git initialization state, the file browser, one readable file, Git tracking/diff, and a populated issue/task list. Do not click pull, push, stage, delete, stop, create, or send.

- [ ] **Step 5: Record live frontend and research footage**

Record the existing World Cup extension at `/extension/world-cup/` for a visually strong runnable frontend result. Record the research overview of existing project `e8bc0a02` (`深度研究教程演示`) or, if that project has no populated graph, project `28a444aa` (`科研工作区`). Use only read-only navigation and show a populated research graph/result rather than a creation form.

- [ ] **Step 6: Record XiaoMo and cross-device UI**

Open the XiaoMo project/panel and show the assistant entry, voice affordance, progress/status surfaces, and the official mobile interface image as a later compositor source. Do not send a message or approve a pending action.

- [ ] **Step 7: Decode and visually inspect recordings**

Decode all eight WebM files with FFmpeg. Extract the midpoint of each clip and tile them into `checks/ui-contact-sheet.png`. Reject and re-record any clip containing a modal error, blank loading state, visible Token/IP, cropped important UI, or unreadable text.

### Task 5: Render the master timeline

**Files:**
- Create: `.imac/generated_videos/71f6091f/production/render-promo.py`
- Create: `.imac/generated_videos/71f6091f/work/subtitles.ass`
- Create: `.imac/generated_videos/71f6091f/work/timeline.json`
- Create: `.imac/generated_videos/71f6091f/work/master-video-no-audio.mp4`
- Create: `.imac/generated_videos/71f6091f/work/master-narration.wav`
- Create: `.imac/generated_videos/71f6091f/work/master-mix.wav`
- Create: `.imac/generated_videos/71f6091f/mobius-agent-os-promo-v1.mp4`

**Interfaces:**
- Consumes: validated manifests, 14 narration MP3s, official/existing sources, fresh UI recordings.
- Produces: final 1920×1080 H.264/AAC MP4 with subtitles and mixed audio.

- [ ] **Step 1: Normalize all visual sources**

For every source generate a 1920×1080, 30 fps, `yuv420p` intermediate. Preserve aspect ratio with a blurred/darkened background fill when the source is 16:10 or portrait. Use `scale`, `crop`, and `pad`; do not stretch UI.

- [ ] **Step 2: Build motion shots 01, 02, 03, and 14**

Use dark navy/black backgrounds, restrained Mobius brand color accents, and ASS-rendered Chinese text. Shot 01 headline is `AI Agent，已经开始工作`; shot 02 is `如果，系统可以由你塑造？`; shot 03 reveals `由用户持续塑造` then `随需求不断进化`; shot 14 ends on `Mobius，塑造属于你的 Agent OS` and the product definition. Keep title states continuous with no blank gaps.

- [ ] **Step 3: Cut the self-evolution proof**

From `self-evolution-source.mp4`, make a 19-second montage containing: before-state right panel, user requirement, 2×2 after-state, second feedback, and balanced final state. Remove source audio. Use consistent right-panel crop and a before/after vertical split so the layout change is visible at mobile size.

- [ ] **Step 4: Assemble capability shots**

Map the fresh project/UI clips to shots 05–09. Build shot 10 from a second crop of the real self-evolution source that shows screenshot feedback, Playwright/browser verification, and the updated result. Build shot 11 as a motion diagram over safe UI texture with the labels `本地 PC`, `SSH / AIMUX`, `云服务器`, and `GPU 算力`; do not show a real IP. Combine the fresh research clip with `can-do-research.gif` for shot 12, and combine the XiaoMo clip with the three official device images for shot 13. Each shot must contain at least one input→execution→result sequence or an explicit labeled relationship. Use 250–400 ms dissolves; avoid decorative transitions that hide the UI.

- [ ] **Step 5: Build synchronized narration and subtitles**

Place each narration MP3 at its shot start plus 300–600 ms. Add silence to preserve the 260-second timeline. Generate ASS subtitles from the narration text, split into at most two lines and no more than 18 Chinese characters per line, with safe-bottom margin 72 px and semitransparent dark backing.

- [ ] **Step 6: Mix BGM and narration**

Loop `bgm.mp3` to 260 seconds. Use narration at reference level, BGM around -24 LUFS under speech, 300 ms fades at both ends, and sidechain compression or explicit volume automation so every word remains clear. Produce a 48 kHz stereo WAV before AAC encoding.

- [ ] **Step 7: Encode the final MP4**

Run FFmpeg with:

```text
-c:v libx264 -profile:v high -pix_fmt yuv420p -r 30 -movflags +faststart -c:a aac -b:a 192k -ar 48000
```

Expected output path: `.imac/generated_videos/71f6091f/mobius-agent-os-promo-v1.mp4`.

### Task 6: Verify, review, and hand off

**Files:**
- Create: `.imac/generated_videos/71f6091f/checks/final-contact-sheet.png`
- Create: `.imac/generated_videos/71f6091f/checks/final-first-frame.png`
- Create: `.imac/generated_videos/71f6091f/checks/final-self-evolution.png`
- Create: `.imac/generated_videos/71f6091f/checks/final-mobile.png`
- Create: `.imac/generated_videos/71f6091f/checks/final-last-frame.png`
- Create: `.imac/generated_videos/71f6091f/checks/verification.txt`

**Interfaces:**
- Consumes: final MP4 and V3 storyboard acceptance criteria.
- Produces: decode evidence, visual review frames, duration/stream evidence, and final clickable handoff.

- [ ] **Step 1: Full decode verification**

Run:

```bash
ffmpeg -v error -i .imac/generated_videos/71f6091f/mobius-agent-os-promo-v1.mp4 -f null -
```

Expected: exit code 0 and no decode errors.

- [ ] **Step 2: Stream and duration verification**

Parse standard FFmpeg probe output and assert: duration 240–280 seconds, video 1920×1080 at 30 fps, pixel format `yuv420p`, audio AAC stereo at 48 kHz. Save sanitized evidence to `checks/verification.txt`.

- [ ] **Step 3: Visual checkpoint extraction**

Extract frames at 3, 20, 34, 52, 72, 132, 173, 216, 248, and 258 seconds. Tile them into `final-contact-sheet.png`. Also save named frames for the opening, self-evolution proof, mobile scene, and final brand card.

- [ ] **Step 4: Inspect the visual checkpoints**

Use `view_image` on the contact sheet and four named frames. Verify readable Chinese copy, no blank frames, no credential leakage, clear 2×2 self-evolution comparison, visible mobile UI, and exact final tagline.

- [ ] **Step 5: Inspect audio and final ending**

Listen to or decode the 15-second opening sample and the last 15 seconds. Verify narration is intelligible over BGM, the last word is not clipped, and the final brand card holds for at least 2.5 seconds.

- [ ] **Step 6: Complete the Session marker and delivery**

Only after Steps 1–5 pass, delete `/home/tianyi/imac-test/.imac/flags/71f6091f/running.flag`. Present the final MP4 and contact sheet as clickable absolute-path links, including size, duration, resolution, codec, and verification result.
