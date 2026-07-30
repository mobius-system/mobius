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
    integration.test.ts   real backend end-to-end (your server)
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
Enter your Mobius server URL and username (most servers are passwordless).
On success the token is saved and the next launch auto-logs in
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
only use the web API. A failed child is retried automatically with exponential
backoff; AIMUX installation or connection failures do not prevent the chat
client from opening. Python discovery, virtual-environment creation, pip
download progress, bridge heartbeat state, and reconnect attempts remain
visible in the TUI status area while the rest of the client stays usable.

Once started, a background heartbeat checks
`/aimux_bridge/api/remotes/<identifier>/connection` every five seconds with the
current Mobius JWT. Three consecutive failed checks terminate the stale AIMUX
child and reconnect with 1/2/4/8/15-second capped exponential backoff. A
successful bridge heartbeat resets the backoff and changes the status indicator
to green.

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
     The session carries `pc_client_metadata` with `is_tui: true`, the local
     AIMUX identifier and current directory; TUI sessions always default to PC mode
     and always include the `mobius-aimux` Skill.
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
MOBIUS_TUI_WAIT_MS=90000 npm run test:integration   # real backend (your server)
npm test                   # all three
```

## Build an installable package

From the repository root:

```bash
python3 build.py --build-tui
```

To build and immediately install the global command into the current user's
`~/.local` prefix:

```bash
python3 build.py --build-tui-and-install
```

For CI or a custom location:

```bash
python3 build.py --build-tui-and-install --tui-install-prefix /custom/writable/prefix
```

The command runs the TUI typecheck and AIMUX regression tests, then writes an
installable npm package plus checksum metadata to `mobius/tui-builds/`:

```text
mobius-tui-<version>.tgz
mobius-tui-<version>.tgz.sha256
manifest.json
```

Install it without `sudo` and without writing to `/usr/local`:

```bash
npm install --global --prefix "$HOME/.local" \
  /path/to/mobius/tui-builds/mobius-tui-<version>.tgz
export PATH="$HOME/.local/bin:$PATH"
mobius
```

If the PATH export is not already in the shell profile, add it to `~/.bashrc`
once. Using the explicit user prefix avoids the `EACCES ... /usr/local/lib/node_modules/mobius`
error produced by a root-owned npm global prefix. The built package promotes
`tsx` to a runtime dependency, so a production/global install can execute the
TypeScript entry point without retaining the source checkout's devDependencies.
