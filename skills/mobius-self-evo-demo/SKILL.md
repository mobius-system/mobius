---
name: mobius-self-evo-demo
description: Produce a Mobius self-evolution demo video for requests that ask to show an existing UI, submit the same requirement to the Xiao Mo assistant, implement the requirement, record the changed UI, concatenate the clips, and deliver an MP4. Use for Mobius self-iteration demo-video tasks based on Playwright, especially Issue/Session flows that mention "自进化演示视频", "基于 Playwright", "录制视频", or three-part before/request/after demonstrations.
---

# Mobius Self-Evolution Demo Video

Use this skill to create a reproducible Mobius self-evolution demo:

## 用户的原始需求

制作自进化演示视频。基于playwright。
1. 首先，我提出一个需求，例如【 “版本追踪tab” 的刷新按钮旁边，应该添加一个多功能按钮（当git仓库存在时），点击后，出现常见的git操作，如“拉取”，“推送”，“暂存”】
2. 接下来，你的第一个任务是，使用playwright打开项目，开始录制视频，展示当前“版本追踪tab”的情况。结束录制。
3. 下一步，开始录制视频，点击右下角的小莫图标，然后把【需求】一个字一个字地输入小莫助手的输入框，点击发送，3秒后结束录制。（因为小莫助手一般需要二次确认才会真正执行，所以，不去动它，需求实际上不会真正执行）
4. 接下来，你的任务是，把修改代码，把【需求】实质性地完成，然后开始录制视频，展示修改后的结果。
5. 把三段视频拼接到一起。下班收工。

按照时间顺序，用户又逐步提出了以下附加要求，在以后的任务中，要充分考虑这些意见
P.S. 对啦 以后要把视频转成mp4
P.S. 三段视频之间要添加转场，第一段和第二段直接：转场字幕“接下来，我们给小莫提出需求，提出需求”。第二段和第三段：转场字幕：“小莫会处理您的指令……等待享用一杯咖啡的时间后……”
P.S. 转场和字幕的特效药动态，效果要好
P.S. 缺东西可以sudo安装
P.S. 转场太奇怪了，朴素一点吧，黑底白字，打字机效果
P.S. 新的转场非常好！再改进两个点：1. 在视频开头，再加一个转场：【让我们来尝试...(在这里阐述本次自进化的目标)...，(换行)首先我们看一下自我迭代之前的样子。】 衔接第一段视频 2. 每段视频的前2秒似乎是页面刚打开的画面，可以删除
P.S. 在视频开头，再加一个转场：【让我们来尝试...(在这里替！换！阐述本次自进化的目标)...，(换行)首先我们看一下自我迭代之前的样子。】 衔接第一段视频：：：你是不是傻，该替换的文字替换掉啊
P.S. 字母换行时，视频会瞬间黑一下，修复这个问题

记得把视频和临时文件放在 .imac/generated_videos/随机名/* 中

## 具体细节

1. Record an opening introduction card that frames the self-evolution goal.
1. Record the current UI before the change.
2. Record the user requirement being typed into Xiao Mo.
3. Implement the requirement.
4. Record the changed UI.
5. Insert plain black title cards with typewriter text between the clips.
6. Trim the first 2 seconds from each recorded clip before final assembly.
7. Concatenate the clips and convert the final video to MP4.

## Required Rules


- Do not use git worktree in this project.
- After a Mobius code-change batch is ready, commit all workspace changes, then run `python3 start.py` so PM2 serves the new code.
- Before recording the after-state clip, confirm `python3 start.py` has been run after the implementation commit.
- Use commit messages in the form `中文代码变动说明 (English code change summary)`.
- Ensure `git config user.email` is `mobius_os@163.com`.
- At final success or failure, remove the Session marker `running.flag` specified by the task context.
- Do not revert unrelated user/concurrent changes. If unrelated files change while working, inspect them, work with them, and commit according to project rules.

## Find the Target

1. Confirm the Mobius service URL from health, not from port guesses:

   ```bash
   curl -sS http://localhost:45616/api/v2/health
   ```

   The Playwright dev-server detector may list common ports such as `3000`,
   `3001`, `5173`, or `8000` and miss the production Mobius port `45616`.

2. Login through `/api/auth/login`. Password login may be disabled:

   ```js
   const { request } = require('playwright');
   const api = await request.newContext({ baseURL: 'http://localhost:45616' });
   const res = await api.post('/api/auth/login', { data: { username: 'user' } });
   const { token } = await res.json();
   ```

3. Locate the self-develop project by API or known project knowledge. For this
   repo, the self-develop project commonly has `bind_path = /home/user/imac-test`
   and route shape:

   ```text
   /u/<userId>/p/<projectId>
   ```

## Record With Playwright

Use the project Playwright skill if present. Scripts should live under `/tmp`,
not inside the repo. Playwright's `recordVideo` produces WebM clips; keep these
raw clips and later convert the final output to MP4.

Prefer `headless: true` when no reliable display is available. Headful Chromium
can hang on stale X11 sockets; headless recording is still a valid browser
automation recording.

Use a stable viewport:

```js
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: '/tmp/imac-demo-video/raw', size: { width: 1440, height: 900 } },
});
await context.addInitScript((value) => {
  localStorage.setItem('cc-token', value);
  localStorage.setItem('cc-background-flow', '0');
}, token);
```

Save each clip explicitly:

```js
const video = page.video();
await context.close();
await video.saveAs('/tmp/imac-demo-video/part1-before.webm');
await browser.close();
```

## Clip 1: Before State

1. Open the target project route.
2. Wait for `[data-tour="project-settings-panel"]`.
3. Click the relevant tab, for example `版本追踪`.
4. Record the current control state for a few seconds.
5. Do not modify data in this clip.

For the version-tracking demo, verify the old state shows `刷新` but no Git
operation menu.

## Clip 2: Xiao Mo Requirement

1. Open the same project route.
2. Click `[data-testid="assistant-bubble"]`.
3. Wait for `[data-testid="assistant-panel"]`.
4. Type the requirement one character at a time:

   ```js
   await page.getByTestId('assistant-input').type(REQUIREMENT, { delay: 45 });
   ```

5. Click the assistant send button.
6. Wait 3 seconds and stop.

Do not click any second confirmation or execution prompt inside Xiao Mo. The
goal is to demonstrate the user submitting the requirement, not to let Xiao Mo
perform the implementation during the recording.

## Implement the Requirement

Follow existing code patterns and keep the change narrow. For a UI capability
inside the project settings panel, likely files are:

- `mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx`
- `mobius/backend/routes/projects.js`

For backend Git operations:

- Use a whitelist of supported actions. Do not accept arbitrary Git args from
  the client.
- Reuse the existing project bind-path and Git repository discovery logic.
- Require project management permission for mutating Git operations.
- Return refreshed tracking data after the action.

For frontend menus:

- Only show Git operation controls when `gitTracking.available` is true.
- Use icon buttons and menus, not text-only ad hoc controls.
- Keep the demo safe: in the after-video, show the menu and hover options; do
  not execute `pull`, `push`, or `stage` unless the task explicitly asks to test
  a specific action.

Validate before recording the after state:

```bash
node -c mobius/backend/routes/projects.js
cd mobius/frontend && npm run build
python3 start.py
curl -sS http://localhost:45616/api/v2/health
```

If testing the new Git route, use an invalid action such as `noop` to verify
the route is mounted without mutating the repository.

## Clip 3: After State

1. Open the target project route after `python3 start.py`.
2. Navigate to the changed UI.
3. Wait for the new control selector, not only visible text. Example:

   ```js
   await page.waitForFunction(() => {
     const panel = document.querySelector('[data-tour="project-settings-panel"]');
     return !!panel
       && (panel.textContent || '').includes('近期 commits')
       && !!panel.querySelector('button[aria-label="Git 操作"]');
   });
   ```

4. Open the new menu.
5. Hover the expected options so the video clearly shows them.
6. Capture a screenshot of the final frame for quick inspection.

## Concatenate And Convert To MP4

Always deliver MP4. Keep WebM intermediates if useful, but the final shared
artifact should be MP4.

Always start with a black introduction card that states the real self-evolution
goal. Write the concrete goal directly before rendering; never leave bracketed
placeholder instructions in the final video.

For the version-tracking Git menu demo, the introduction should say:

- `让我们来尝试给版本追踪 tab 添加 Git 操作菜单，`
- `支持拉取、推送和暂存。`
- `首先我们看一下自我迭代之前的样子。`

Then insert plain black transition title cards between the three recorded
clips. Keep them plain: black background, white text, and a typewriter effect
that reveals the text character by character. Avoid colorful gradients or
decorative motion unless the user explicitly asks for a stylized transition.
When implementing the typewriter effect with ASS subtitles, do not leave timing
gaps between `Dialogue` events. A gap during a line break or cursor blink means
the black background renders with no text for one or more frames, which looks
like a sudden black flash. Hold the previous visible text through inter-line
pauses, cursor-on intervals, and cursor-off intervals so the title card is
continuously covered from the start to the end of the card.

Trim the first 2 seconds from each recorded clip before final assembly, because
the beginning often shows the page just opening.

- Between clip 1 and clip 2:
  `接下来，我们给小莫提出需求，提出需求`
- Between clip 2 and clip 3:
  `小莫会处理您的指令……等待享用一杯咖啡的时间后……`

Prefer the bundled renderer because the local static `ffmpeg` may not include
the `drawtext` filter, and `xfade` can fail when an input loses constant-frame-
rate metadata. The renderer uses ASS subtitles for Chinese typewriter text,
black `color` video sources, internal fades, and normalized MP4 concatenation:

```bash
python3 skills/mobius-self-evo-demo/scripts/render_demo_video.py \
  --work-dir /tmp/imac-demo-video \
  --part1 /tmp/imac-demo-video/part1-before.webm \
  --part2 /tmp/imac-demo-video/part2-request.webm \
  --part3 /tmp/imac-demo-video/part3-after.webm \
  --intro "让我们来尝试给版本追踪 tab 添加 Git 操作菜单，|支持拉取、推送和暂存。|首先我们看一下自我迭代之前的样子。" \
  --trim-start 2 \
  --output .imac/generated_videos/<session-or-flag-id>/self-evolution-demo.mp4
```

The renderer creates:

- `intro-animated.mp4`
- `transition1-animated.mp4`
- `transition2-animated.mp4`
- the final `self-evolution-demo.mp4`

Only fall back to manual concatenation when the renderer is unavailable.

Create a concat list:

```text
file '/tmp/imac-demo-video/part1-before.webm'
file '/tmp/imac-demo-video/part2-request.webm'
file '/tmp/imac-demo-video/part3-after.webm'
```

Concatenate to a combined WebM:

```bash
ffmpeg -y -f concat -safe 0 \
  -i /tmp/imac-demo-video/concat.txt \
  -c copy /tmp/imac-demo-video/self-evolution-demo.webm
```

Convert the final video to MP4:

```bash
ffmpeg -y -i /tmp/imac-demo-video/self-evolution-demo.webm \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  /tmp/imac-demo-video/self-evolution-demo.mp4
```

Copy the MP4 into a persistent project artifact directory:

```bash
mkdir -p .imac/generated_videos/<session-or-flag-id>
cp /tmp/imac-demo-video/self-evolution-demo.mp4 \
  .imac/generated_videos/<session-or-flag-id>/self-evolution-demo.mp4
```

If an older run already produced only a WebM artifact, transcode that WebM and
store the MP4 next to it before reporting completion.

If concat copy fails because clips have incompatible stream parameters,
transcode directly:

```bash
ffmpeg -y -f concat -safe 0 \
  -i /tmp/imac-demo-video/concat.txt \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  /tmp/imac-demo-video/self-evolution-demo.mp4
```

## Verify Video

`ffprobe` may not be installed. Use `ffmpeg` for decode validation:

```bash
ffmpeg -i /tmp/imac-demo-video/self-evolution-demo.mp4 -f null -
```

Extract and inspect a final frame:

```bash
ffmpeg -y -sseof -2 \
  -i /tmp/imac-demo-video/self-evolution-demo.mp4 \
  -update 1 -vframes 1 /tmp/imac-demo-video/final-last-frame.png
```

Use `view_image` or `display_images` to confirm the final frame shows the
after-state UI.

For title cards, also inspect frames around line breaks and the end of the
intro. This catches the common ASS timing bug where text disappears briefly
when the renderer switches to the next typed line:

```bash
ffmpeg -y -ss 3.4 \
  -i .imac/generated_videos/<session-or-flag-id>/self-evolution-demo.mp4 \
  -update 1 -vframes 1 /tmp/imac-demo-video/intro-linebreak-check.png

ffmpeg -y -ss 5.1 \
  -i .imac/generated_videos/<session-or-flag-id>/self-evolution-demo.mp4 \
  -update 1 -vframes 1 /tmp/imac-demo-video/intro-final-check.png
```

Inspect generated ASS files when a title card flashes:

```bash
sed -n '1,140p' /tmp/imac-demo-video/intro.ass
```

The `End` time of one visible state should match the `Start` time of the next
state through line changes. If a line finishes at `0:00:02.38` and the next
line starts at `0:00:02.60`, the video will briefly show only black.

Use this check to catch subtitle gaps automatically:

```bash
python3 - <<'PY'
from pathlib import Path

def seconds(ts):
    h, m, rest = ts.split(':')
    s, cs = rest.split('.')
    return int(h) * 3600 + int(m) * 60 + int(s) + int(cs) / 100

for name in ('intro.ass', 'transition1.ass', 'transition2.ass'):
    events = []
    for line in (Path('/tmp/imac-demo-video') / name).read_text(encoding='utf-8').splitlines():
        if line.startswith('Dialogue:'):
            parts = line.split(',', 9)
            events.append((seconds(parts[1]), seconds(parts[2])))
    gaps = [
        (prev[1], cur[0])
        for prev, cur in zip(events, events[1:])
        if cur[0] - prev[1] > 0.011
    ]
    print(f'{name}: events={len(events)} gaps={len(gaps)}')
    if gaps:
        raise SystemExit(f'{name} has subtitle gaps: {gaps[:5]}')
PY
```

## Lessons From Prior Run

- Browser display: `DISPLAY` can be empty while stale X11 sockets exist. A
  smoke test may pass once and later headful launch can hang. Prefer headless
  Playwright recording for reliability unless a visible browser is truly needed.
- Video effects: the local static `ffmpeg` may have `ass` and `xfade` but no
  `drawtext`. Prefer ASS subtitle animation for Chinese title cards. Keep the
  default cards plain: black background, white text, and typewriter reveal.
  Trim the first 2 seconds from each recorded clip before the final render.
  Replace intro-card goal placeholders with the concrete self-evolution target.
  Avoid sparse ASS events: the typewriter renderer must output continuous
  subtitle states, including the pause before a new line starts. Otherwise the
  title card briefly turns pure black when text wraps or moves to the next line.
  If `xfade` rejects inputs as non-constant-frame-rate, use transition clips
  with normalized concat instead of installing another ffmpeg build.
- Service discovery: automated dev-server detection can miss Mobius production
  port. Trust `/api/v2/health`.
- Selectors: aria labels are not body text. Wait for selectors such as
  `button[aria-label="Git 操作"]` instead of waiting for text that is only in an
  attribute.
- Route testing: verify dangerous routes with invalid/no-op input first.
- Concurrent edits: README or other files may be modified by another session.
  Do not revert them. Inspect, wait briefly if the file is actively changing,
  then commit according to the project rule.
- Git status: check `git status --short` before and after every commit/start
  cycle.
- Final cleanup: remove `running.flag` only after implementation, videos,
  validation, commits, and service update are complete.
