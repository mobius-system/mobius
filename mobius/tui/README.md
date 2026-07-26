# Mobius

A terminal client for [Mobius](../..), written in Node + TypeScript +
[Ink](https://github.com/vadimdemes/ink) (React for CLIs). It reuses the web
frontend's TypeScript domain types and jsonl entry shapes verbatim, and drives
the same backend HTTP + SSE API the web UI uses.

```
mobius/tui/
  src/
    main.tsx              entry — Ink render, exitOnCtrlC disabled
    App.tsx               route machine: login → prep → chat (+ resume)
    config.ts             ~/.mobius/{login,projects,dir2project,dir2project_preference}.json
    api.ts                MobiusClient — all HTTP endpoints (bearer auth)
    sse.ts                SseConnection — streaming fetch SSE frame parser
    markdown.ts           terminal markdown (marked lexer + cli-highlight + chalk)
    types.ts              domain + jsonl entry types (copied from frontend)
    lib/entry-view.ts     jsonl entry → renderable view (copied classify fns)
    hooks/useChat.ts      one session: lazy create + SSE + send
    components/
      primitives.tsx      TextInput / Select (single+multi) / Spinner
      Login.tsx           server + username + optional password
      PrepScreen.tsx      project picker + preference wizard (issue→model→language→skill→memory)
      Chat.tsx            viewport-aware transcript + welcome card + composer/status
      ResumePicker.tsx    /resume — 32 most-recent project sessions
  tests/
    integration.test.ts   real backend end-to-end (cloud-17)
    ui.test.tsx           ink-testing-library + mocked fetch/SSE
  bin/mobius-tui.js       launcher
```

## Run

```bash
cd mobius/tui
npm install --include=dev      # NODE_ENV=production prunes devDeps → must pass --include=dev
npm start --silent             # suppress npm's script banner
# or (cleanest): ./bin/mobius-tui.js
```

On first launch there is no `~/.mobius/login.json`, so the login screen appears.
Defaults target `https://cloud-17.agent-matrix.com` (user `fuqingxu`,
passwordless). On success the token is saved and the next launch auto-logs in
(validated via `/api/auth/me`; re-login on expiry).

After a successful login the TUI also starts its local AIMUX reverse connection
in the background. The first run creates `~/.mobius/aimux-venv` and installs
the `aimux` Python package, then runs:

```text
aimux reverse connect <server>/aimux_bridge --identifier tui-<hostname> --token <jwt> --replace
```

Python 3.10+ is discovered from `MOBIUS_TUI_PYTHON`, `python3`/`python` (or
Windows `py`). If none is available and `uv` is installed, the TUI runs
`uv python install 3.11` for a user-local interpreter. Set
`MOBIUS_TUI_DISABLE_AIMUX=1` to opt out, for example on a machine that should
only use the web API. A failed child is retried automatically after five
seconds; AIMUX installation or connection failures do not prevent the chat
client from opening.

## Flow

1. **Login** — server / username / password → `POST /api/auth/login` → save
   `~/.mobius/login.json`.
2. **Prep**
   - read `cwd`; look up `dir2project.json[cwd]`.
   - if unbound → pick an existing project or create one (bound to `cwd`).
   - preference wizard, stepped only through what's missing:
     **Issue (task)** → **model** → **language** → **skills** → **memories**.
     Preferences are stored *inside* the selected issue, so switching issues
     restores that issue's choices.
3. **Chat**: startup identity/context card, viewport-aware
   transcript, composer, and persistent model/project/task status at the bottom.
   The final line always shows the current web issue/session URL as an OSC 8
   hyperlink, so supported terminals can open the matching Mobius page directly
   (the URL remains visible and copyable everywhere).
   - The first submitted message lazily creates a session
     (`POST /api/issues/:iid/sessions`) with the saved preferences, opens the
     SSE stream (`GET /api/sessions/:id/events?token=`), and posts the message.
   - `jsonl_entry` events append to the transcript as they arrive; the view keeps
     recent output inside the current terminal height instead of mixing permanent
     `<Static>` rows with dynamic UI.
   - The `typing` event drives the working indicator. Press Esc (or Ctrl+C) to
     interrupt a running turn.
   - Slash commands: `/clear` (new session), `/resume` (history), `/help`,
     `/quit`. Ctrl+C stops a running turn, or quits when idle.

## Reusing the web frontend

The domain interfaces (`User`, `Project`, `Issue`, `Session`, `Message`,
`SessionModelOption`) are copied from `frontend/src/store.ts`; the jsonl
entry / render-block types from `frontend/src/components/viewer/types.ts`; and
the pure helpers `assistantResponseText`, `assistantEntryText`, `entryUserText`
and the noise predicates from `frontend/src/components/viewer/entry-classify.ts`.
`api.ts` mirrors the frontend's `api()` helper (`Authorization: Bearer`, JSON).

## Backend contract notes (gotchas)

- Sessions are created under **issues**, not projects:
  `POST /api/issues/:issueId/sessions`.
- Issue title field is **`title`**; session name field is **`name`**.
- Worktree flag is **`use_worktree`** (issues) / **`defaultUseWorktree`** (projects).
- Skill/Memory preferences are **exclusion lists** (`excluded_skill_ids` /
  `excluded_memory_ids`); omitting = everything enabled.
- Model field is a short **`key`** from `GET /api/sessions/model-options`.
- No SSE `done`/`tool_call` events — everything is a `jsonl_entry` carrying a raw
  Claude/Codex SDK entry; turn-end = `typing active:false`.

## Test

```bash
npm run typecheck
npm run test:ui            # mocked fetch + fake SSE, no network
MOBIUS_TUI_WAIT_MS=90000 npm run test:integration   # real backend (cloud-17)
npm test                   # all three
```
