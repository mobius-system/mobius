---
name: mobius-aimux
description: For agents (小莫 / 执行会话 / Claude Code worker). Operate a remote machine (Windows, Linux, Mac) that a user has reverse-connected into the imac-test mobius broker via `aimux reverse connect`. Use when the user says "I bridged my Windows box in" / "I ran the connect command" / "can you see my files", and you need to actually run shells, capture output, or transfer files on their box from this server. Covers the JWT → broker-token swap, the mandatory `AIMUX_BRIDGE_RUNTIME` env var, picking the right profile (cmd / powershell / mingw64 / bash), the agent-friendly session lifecycle (`new` → `send-keys` → `capture` → `kill`), file transfer, and a verified end-to-end example against a bridged Windows host (2026-06-17).
---


# aimux 连接指南：反向（Bridge）设备

> 本指南**专门针对「反向连接型」设备**——即设备**主动连回**中转（bridge）、我们经 bridge 反向接入它的场景（如 `<device_name>` / yahboom Jetson）。
>
> 它**不是**普通的正向 SSH 远程。先按第 0 节确认你的设备属于「反向」类型，再按本指南操作。

---

## 0. 先分清：你连的是「反向设备」吗？

| 特征 | 正向 SSH 远程 | **反向 Bridge 设备（本指南）** |
|------|---------------|------------------------------|
| 连接方向 | 我们 → 主动 SSH 过去 | 设备 → 主动连回 bridge，我们经 bridge 接入 |
| `aimux remote ls` 的 TYPE | `ssh` | **`bridge`** |
| HOSTNAME/PROFILES 列 | 真实 IP/域名 | **profile 名**（如 `posix-pty`），无固定 IP |
| PORT | 有端口号 | 通常为 `-` |
| 创建会话 | `--remote <host>` 即可 | **必须额外带 `--profile`** |

判断方法：`aimux remote ls` 后，目标设备 `TYPE` 列为 **`bridge`** 即为反向设备。

---

## 1. 安装 aimux（首次使用）

如果环境中尚未安装 aimux，使用以下任一方式安装。无论哪种方式，都需要更新到 **最新版**。

### 方式 A：uv（推荐，本环境验证）

```bash
uv tool install aimux
```

安装后，可执行文件位于 `~/.local/bin`。若提示不在 PATH 中：

```bash
export PATH="/root/.local/bin:$PATH"
# 或永久生效：
uv tool update-shell
```

### 方式 B：pip

```bash
pip install aimux          # 或 uv pip install aimux（uv venv 环境）
```

### 验证安装

```bash
aimux -h          # 注意：aimux 没有 --version 选项，用 -h 验证即可
```

---

## 2. 识别反向设备及其 profile

反向设备的**核心特征**是它带有 `profiles`（连接配置），创建会话时必须选定一个。

### 2.1 看设备列表

```bash
aimux remote ls
```

反向设备的行大致长这样（注意 TYPE=bridge、PORT=-、PROFILES 列是个名字）：

```
HOST         TYPE    USER/PLATFORM  HOSTNAME/PROFILES  PORT  STATUS     RTT
<device_name>  bridge  linux          posix-pty          -     connected  -
```

### 2.2 看 profile 名（**必做**）

```bash
aimux remote ls --json
```

重点关注：

```json
[
  {
    "name": "<device_name>",
    "type": "bridge",
    "default_profile": "posix-pty",
    "profiles": [
      {"name": "posix-pty", "available": true}
    ],
    "status": "connected"
  }
]
```

> 🔑 记下 `profiles[*].name`（本例 `posix-pty`），下一步 `--profile` 就取它。多数情况直接用 `default_profile` 即可。

### 2.3 状态判读

| STATUS | 能否使用 |
|--------|---------|
| `connected` | ✅ 设备已反向连回，可直接用 |
| `auth-required` | ❌ 设备未上线或认证未通，需等待设备重连 / 排查 bridge |

---

## 3. 创建会话（反向设备的关键步骤）

⚠️ **反向设备创建会话必须带 `--profile`**，否则报错：
`error: --profile is required for bridge remote '<device_name>'`

```bash
aimux new --remote <device_name> --profile posix-pty --name <session-name>
```

常用选项：

```
aimux new [OPTIONS]
  *  --name                会话名（必填）
     --remote              反向设备名（如 <device_name>）
     --profile             profile 名（反向设备必填，如 posix-pty）   ← 核心
     --cwd                 初始工作目录
     --cmd                 初始执行的命令
     --output-sync-to-file 实时镜像 pane 输出到文件
     --reuse               会话已存在则直接返回成功（避免重复创建报错）
```

变体示例：

```bash
# 指定初始目录
aimux new --remote <device_name> --profile posix-pty --name ros --cwd /home/jetson/catkin_ws

# 安全复用
aimux new --remote <device_name> --profile posix-pty --name embedded-test --reuse
```

---

## 4. 操作会话（send-keys + capture）

反向设备的会话标识为 `<设备名>/<会话名>`。⚠️ 智能体用 `send-keys` + `capture`，**不要用 `attach`**（那是给人交互用的）。

### 4.1 发送命令

```bash
# 末尾 Enter 表示回车提交
aimux send-keys "<device_name>/embedded-test" -- 'uname -a' Enter

# 一次发多行
aimux send-keys "<device_name>/embedded-test" -- 'cd /tmp' Enter 'ls -la' Enter
```

### 4.2 捕获输出

```bash
aimux capture "<device_name>/embedded-test" --lines 30
```

输出通常带 ANSI 颜色/光标码，需要干净文本就过滤：

```bash
aimux capture "<device_name>/embedded-test" --lines 40 \
  | sed 's/\x1b\[[0-9;]*[mGKHJ]//g; s/\x1b\][0-9];[^\x07]*\x07//g'
```

### 4.3 等待执行

反向设备经 bridge 中转，命令执行有延迟。发送后 `sleep N` 再 capture。
> ⚠️ `aimux wait-last-command-complete` **仅本地会话支持，反向 bridge 会话不可用**。

---

## 5. 文件传输

反向设备同样走 sftp 通道，只是把「远程地址」换成设备名即可：

```bash
# 上传：本地 → 设备
aimux send_files <device_name> /home/jetson/upload ./run.py ./data.csv
#   （加 --gitignore 可跳过被忽略的文件）

# 下载：设备 → 本地
aimux get_files <device_name> ./downloads /home/jetson/logs/
```

---

## 6. 销毁会话

```bash
aimux kill "<device_name>/embedded-test"
```

> ⚠️ `kill` 不支持通配符/批量，需逐个销毁。

---

## 7. 端到端实战（连接 yahboom Jetson 反向设备）

```bash
# 0. PATH（首次）
export PATH="/root/.local/bin:$PATH"

# 1. 确认是反向设备 + 拿到 profile 名
aimux remote ls --json        # → type=bridge, default_profile=posix-pty

# 2. 创建会话（带 --profile）
aimux new --remote <device_name> --profile posix-pty --name embedded-test

# 3. 发命令取设备信息
aimux send-keys "<device_name>/embedded-test" -- 'uname -a; hostname; df -h /' Enter
sleep 2
aimux capture "<device_name>/embedded-test" --lines 40

# 4. 上传脚本
aimux send_files <device_name> /home/jetson/scripts ./run.py

# 5. 用完销毁
aimux kill "<device_name>/embedded-test"
```

---

## 8. 反向设备常见问题

| 现象 | 原因 / 解决 |
|------|-------------|
| `--profile is required for bridge remote` | 反向设备未带 `--profile`。先 `aimux remote ls --json` 查 profile 名 |
| 设备状态 `auth-required` / 时连时断 | 设备未稳定反向连回 bridge；等设备重连或排查设备端 bridge 客户端 |
| 创建会话后 capture 无输出 | 命令仍在执行，加大 `sleep` 再 capture；确认 profile 的 `available=true` |
| `wait-last-command-complete` 报错 | 该命令仅本地会话支持，反向 bridge 不可用 → 改用 `sleep` + `capture` |
| `new` 报会话已存在 | 加 `--reuse` |
| capture 输出乱码 | ANSI 码，用第 4.2 节 `sed` 过滤 |

---

## 9. 速查表

```bash
aimux remote ls [--json]                                 # 识别反向设备 + 拿 profile
aimux new --remote <dev> --profile <p> --name <sess>     # 创建反向会话（必带 --profile）
aimux ls                                                 # 列出会话
aimux send-keys "<dev>/<sess>" -- '<cmd>' Enter          # 发命令
aimux capture "<dev>/<sess>" --lines N                   # 取输出
aimux send_files <dev> <remote_dir> <local>...           # 上传
aimux get_files  <dev> <local_dir>  <remote>...          # 下载
aimux kill "<dev>/<sess>"                                # 销毁
```



# Driving a user's bridged client from the mobius server

`aimux` (on PyPI) is an agent-friendly tmux wrapper. Two ways for an agent on this server to reach a remote host:

| Mode | How the host is reached | When the agent should pick it |
|---|---|---|
| **SSH remote** | Host is in `~/.ssh/config`; aimux ssh's into it | Host is directly SSH-reachable from this server |
| **Bridge remote** | Host reverse-connected into the broker; broker relays RPCs over SSE | User has run `aimux reverse connect` from a box behind NAT/firewall |

This SKILL is the recipe for the **bridge remote** case: the user has connected their laptop / Windows desktop / external box into the broker, and you (the agent) now need to drive that box — typically to inspect files, run a quick diagnostic, or transfer data — without ever SSH-ing into it.

## Agent workflow (always follow this order)

When the user says something like "I bridged my Windows box in" or "can you see my files at home", do not start sending commands immediately. Walk through these steps:

1. **Confirm the broker is up** — `pm2 list | grep mobius-system-bridge` should show `online`. If not, the whole subsystem is down; report this to the user and stop.
2. **Find the user's identifier** — ask if not given ("what `--identifier` did you use?"). Also ask which profile they want if they care (default: `powershell` on Windows, `bash` on Linux/Mac).
3. **Verify the client is registered and online** — `curl /api/remotes` against the broker with the runtime token (recipe below). The user's identifier must appear with `"status": "connected"`. If missing or `disconnected`, ask the user to re-run `aimux reverse connect` and keep that terminal open; do **not** retry in a loop.
4. **Export `AIMUX_BRIDGE_RUNTIME`** in your shell before any `aimux` command (mandatory — see dedicated section).
5. **Open exactly one session** with `--reuse`, do your work with `send-keys` + `capture`, then `kill` it. Do not leave sessions dangling — the broker keeps them in memory and they pollute the user's `aimux ls` view.
6. **Report results back in chat** — paste the captured output; never silently assume success.

If any step fails, prefer telling the user what failed and asking them to fix the client side over retrying blindly. Bridge connections are fragile (relies on a long-lived SSE stream over the user's home internet); "it worked a minute ago" is not a guarantee it still works now.

## When to use

- A user says "I bridged my Windows box in" / "I ran the aimux connect command from the modal".
- `aimux remote ls` shows a host, but it's a **bridge** host (status `connected`, not via `~/.ssh/config`).
- The host is behind NAT and there's no way to SSH *into* it from here.

If the host is SSH-reachable, just use `aimux new --remote <ssh-host>` — no broker involved. If `aimux remote ls` already shows the host as `bridge` with `connected` status, this SKILL applies.

## Architecture (one paragraph)

The broker runs on this server at `127.0.0.1:${AIMUX_BRIDGE_PORT}` (default 45615), managed by PM2 as `mobius-system-bridge`. External clients can't reach it directly (it binds localhost only); they connect to `https://mobius.example.com/aimux_bridge/*` instead, which mobius reverse-proxies to the broker. The proxy swaps the caller's **mobius JWT** for the **broker's internal Bearer token** (read from `runtime.json`) before forwarding. The broker then relays RPCs (`session.create`, `session.send_keys`, `session.capture`, `session.kill`, file ops) to the client over an SSE event stream that the client holds open. The client runs the command locally and POSTs the result back via `/client/result`.

```
Windows / external box           this server
─────────────────────            ───────────────────────────────────────
aimux reverse connect   ──HTTPS──> cloud-17 → mobius :45616 → broker :45615
  (uses mobius JWT)                     │
  ◄─── SSE: tasks stream back ──────────┘
  ──── POST /client/result ─────────────>
```

## Prerequisites (all three must be true)

1. **Broker is running.** Check: `pm2 list | grep mobius-system-bridge` → `online`. Logs at `/tmp/mobius-bridge.log`.
2. **Client has reverse-connected.** The user got the command from the in-app "AimuxGuide" modal (top-right user menu → aimux). The command shape is:
   ```
   aimux reverse connect https://mobius.example.com/aimux_bridge \
     --identifier <name> --token <mobius JWT>
   ```
   Success output on the client: `connected bridge remote '<name>'; profiles=...; default=...`.
3. **Your shell knows where `runtime.json` is.** This is the easy step to miss — see next section.

## Setting `AIMUX_BRIDGE_RUNTIME` (mandatory)

The system `aimux` CLI (`~/.local/bin/aimux`) defaults to `~/.aimux/bridge/runtime.json`, which is **stale** on this server. The real runtime file is at `protected_data/aimux-bridge/runtime.json` (the path the broker was launched with via PM2 env).

Set it before any `aimux` command:

```bash
export AIMUX_BRIDGE_RUNTIME=$APP_DIR/protected_data/aimux-bridge/runtime.json
```

Verify the broker is reachable and the client is online:

```bash
TOK=$(python3 -c "import json;print(json.load(open('$AIMUX_BRIDGE_RUNTIME'))['token'])")
curl -s -H "Authorization: Bearer $TOK" \
  http://127.0.0.1:45615/api/remotes | python3 -m json.tool
```

Expect a `remotes` array with your `<name>` having `"status": "connected"`. The `profiles` array tells you which shells the client supports (Windows: `cmd`, `powershell`, `mingw64`; Linux/Mac: `bash`/`zsh` typically).

If `status` is `disconnected` or the name is absent, the client's `aimux reverse connect` has stopped — ask the user to re-run it and **keep that terminal open**.

## Picking a profile

Bridge remotes **require** `--profile`. The choices depend on the client OS:

| Client OS | Typical profiles | Recommendation |
|---|---|---|
| Windows | `cmd`, `powershell`, `mingw64` | `powershell` — richest scripting; `mingw64` if you need Unix-style tools (ls, grep, ssh) |
| Linux | `bash`, `zsh` | `bash` |
| macOS | `zsh`, `bash` | `zsh` |

`default_profile` in `/api/remotes` is the client's preferred one. Use it unless you have a reason not to.

## Session lifecycle

All commands take the target as `<remote>/<session-name>`.

### Create a session

```bash
aimux new --remote <name> --profile powershell --name <session-name>
# Add --reuse to be idempotent (returns OK if session already exists)
# Add --cwd "<path>" to start in a specific directory
# Add --cmd "<command>" to run a command instead of an interactive shell
```

Failure modes:
- `error: --profile is only valid for bridge remotes` → your `AIMUX_BRIDGE_RUNTIME` env isn't set, so aimux fell back to SSH-host mode. Re-export it.
- `error: bridge remote '<name>' is disconnected` → client went away. Re-connect on the client.
- `error: bridge request to '<name>' timed out` (after ~30s) → either the client died mid-request, or you're using a stale `name` (broker still shows `connected` but the SSE stream is dead). Re-connect with a new identifier and try again.

### Send keys (run commands)

`aimux send-keys` mirrors `tmux send-keys` — keys are sent verbatim, and `Enter` is a separate token that submits the line.

```bash
# PowerShell: list home directory
aimux send-keys "<name>/<session>" -- \
  'Get-ChildItem | Select-Object Name,Length,LastWriteTime | Format-Table -Auto' Enter

# cmd.exe equivalent
aimux send-keys "<name>/<session>" -- 'dir' Enter

# bash/mingw64 equivalent
aimux send-keys "<name>/<session>" -- 'ls -la' Enter
```

For multi-line scripts, pass each line followed by `Enter`. Quote shell metacharacters with single quotes around the whole payload; aimux does not re-parse them.

### Capture output

```bash
aimux capture "<name>/<session>" --lines 50
```

Captures the visible screen buffer (`screen-buffer` mode per the profile). Aimux on Windows does **not** scroll-back capture — if output has scrolled off, increase `--lines` won't help; instead re-run with output redirected to a file and `cat`/`type` the file.

### Kill a session

```bash
aimux kill "<name>/<session>"
```

Always clean up sessions you create — the broker keeps them in memory until the client disconnects.

## File transfer

Bridge remotes support `send_files` (upload) and `get_files` (download) via the broker's file endpoints. Same signature as SSH remotes:

```bash
# Upload local → remote
aimux send_files <name> '<remote-dir>' <local-path-1> [<local-path-2>...] [--gitignore]

# Download remote → local
aimux get_files <name> '<local-dir>' <remote-path-1> [<remote-path-2>...]
```

Paths use the client OS convention (Windows: `C:\Users\...` or `\\wsl$\...`; Unix: `/home/...`).

## Worked example: bridged Windows host

Verified end-to-end on 2026-06-17. The user pasted into chat:

> ```
> aimux reverse connect https://mobius.example.com/aimux_bridge --identifier my-windows-boxx --token <JWT>
> connected bridge remote 'my-windows-boxx'; profiles=cmd,powershell,mingw64; default=cmd
> ```
>
> 测试 windows 链接，你能看到我 windows 的文件吗

The agent (on this server) responded with:

```bash
export AIMUX_BRIDGE_RUNTIME=$APP_DIR/protected_data/aimux-bridge/runtime.json

# 1. Verify client is online
TOK=$(python3 -c "import json;print(json.load(open('$AIMUX_BRIDGE_RUNTIME'))['token'])")
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:45615/api/remotes \
  | python3 -c "import json,sys;[print(r['name'],r['status']) for r in json.load(sys.stdin)['remotes']]"
# → my-windows-boxx connected

# 2. Open a session
aimux new --remote my-windows-boxx --profile powershell --name wbx-ps1 --reuse

# 3. Where am I?
aimux send-keys "my-windows-boxx/wbx-ps1" -- \
  'Get-Location | Select-Object -ExpandProperty Path' Enter
sleep 1
aimux capture "my-windows-boxx/wbx-ps1" --lines 5
# → C:\Users\example-user

# 4. List the home dir to answer the user's question
aimux send-keys "my-windows-boxx/wbx-ps1" -- \
  'Get-ChildItem | Select-Object Name,Length,LastWriteTime | Format-Table -Auto' Enter
sleep 2
aimux capture "my-windows-boxx/wbx-ps1" --lines 40
# → Desktop, Documents, Downloads, miniconda3, OneDrive, Pictures, .ssh, seadrive, ...

# 5. Clean up
aimux kill "my-windows-boxx/wbx-ps1"
```

Then the agent answered in chat: "Yes — I can read `C:\Users\example-user`. I see Desktop, Documents, Downloads, miniconda3, OneDrive, Pictures, etc."

Real latency: `new` returns in ~100ms (no RPC, just broker bookkeeping); `send-keys` + `capture` round-trips in 1–3s depending on Windows process spawn time.

## Common pitfalls

- **`--profile is only valid for bridge remotes`** — your `AIMUX_BRIDGE_RUNTIME` env var isn't exported in the current shell. The CLI silently fell back to SSH-host mode. Re-export and retry.
- **`timed out` after 30s but broker shows `connected`** — the SSE stream from client to broker has died but the broker hasn't noticed yet (TCP keepalive hasn't fired). Re-run `aimux reverse connect` on the client with a fresh identifier; the old one is poisoned.
- **Wrong runtime.json path** — there are *two* files that look right: `~/.aimux/bridge/runtime.json` (stale, points at a dead pid) and `protected_data/aimux-bridge/runtime.json` (live). The latter is correct on this server. If `cat $AIMUX_BRIDGE_RUNTIME` shows a pid that doesn't match `pgrep -f 'bridge deploy'`, you have the wrong one.
- **`curl -sN ... | head` shows zero bytes for SSE** — shell pipe buffering. The kernel pipe buffer holds small SSE frames (`: connected\n\n` is ~13 bytes) until EOF or buffer fill. Test SSE with `curl --max-time N` (no pipe) instead.
- **Profile mismatch** — Windows `cmd` does not understand PowerShell cmdlets (`Get-ChildItem`, etc.); bash does not understand `dir`. Pick the profile that matches the syntax you're sending.
- **Capture shows nothing after a command** — `send-keys` is fire-and-forget; the command may still be running. `sleep 1–3` before `capture`, or use `--cmd` at session creation to run-to-completion.
- **Identifier collision** — registering the same identifier twice (no `--replace`) leaves both in the broker's table; one of them is a zombie that never receives RPCs. Always use a fresh name when reconnecting, or add `--replace` on the client.
- **JWT expired (typical mobius JWT is valid ~7 days)** — the in-app AimuxGuide modal always shows a fresh JWT from `localStorage['cc-token']`; re-copy from there if you see `auth_required` from mobius.
- **No output files / repo clutter** — bridge RPCs don't write any scratch files; `send_files`/`get_files` only touch the paths you name. No `/tmp` cleanup needed.

## When **not** to use this

- The host is directly SSH-reachable from this server. Use `aimux remote add` + `aimux new --remote <ssh-host>`; no broker involved, lower latency, no SSE fragility.
- You need to run a single one-off command. Just `ssh <host> '<cmd>'` is simpler than broker round-trip + session management.
- The host is in the same LAN and you have SSH credentials. Bridge mode exists for hosts that *can't* be SSH'd into from here; if they can, prefer SSH.
- You need to transfer >100MB. The bridge broker buffers whole file payloads in memory; for big transfers, set up an SSH tunnel or use `scp`/`rsync` directly.
- The user expects stateful interactivity (Vim, TUI). aimux `send-keys` + `capture` works but is clunky for full-screen apps; use `aimux attach` (human-only — agents should not attach).

## Reference: broker endpoints (debug only)

The broker speaks a small HTTP protocol; you usually don't need these (the `aimux` CLI wraps them), but they're useful for debugging:

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | broker token | Liveness probe |
| `GET /api/remotes` | broker token | List registered clients + status + profiles |
| `GET /api/sessions` | broker token | List active sessions |
| `POST /api/sessions` | broker token | Create session (body: `remote`, `name`, `profile`, ...) |
| `POST /api/sessions/<r>/<n>/send-keys` | broker token | Send keys |
| `POST /api/sessions/<r>/<n>/capture` | broker token | Capture screen |
| `POST /api/sessions/<r>/<n>/kill` | broker token | Kill session |
| `GET /api/remotes/<r>/files/{stat,read,write,mkdir,list}` | broker token | File ops |
| `GET /client/events?identifier=<name>` | broker token | SSE stream the client subscribes to |
| `POST /client/register` | broker token | Client registration (called by `aimux reverse connect`) |
| `POST /client/result` | broker token | Client reports RPC result |

Broker token comes from `runtime.json` (`token` field). External callers don't use this token — they use a mobius JWT against `https://mobius.example.com/aimux_bridge/*`, and the mobius proxy swaps it for the broker token internally.
