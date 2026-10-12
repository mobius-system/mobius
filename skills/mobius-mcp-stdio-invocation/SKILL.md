---
name: mobius-mcp-stdio-invocation
description: Invoke any MCP (Model Context Protocol) server directly from the CLI via stdio JSON-RPC, with no Claude Code / harness dependency. Use when you need to call MCP tools (web search, image understanding, file ops, custom tools) from a shell script, CI job, or a session that doesn't have the MCP auto-loaded. Covers: installing `uv`/`uvx` (or `npx`), spawning the server, the JSON-RPC 2.0 handshake, `tools/list` discovery, `tools/call` invocation, and result parsing — with the MiniMax `minimax-coding-plan-mcp` package as a verified worked example.
---

# MCP stdio invocation from the CLI

MCP servers speak **JSON-RPC 2.0 over stdio** — the server's stdin is the request stream, stdout is the response stream, stderr is for human logs. Any process that can spawn a subprocess and read/write its stdio can be an MCP client. You do **not** need Claude Code, Cursor, or any harness to use them.

This SKILL is the recipe for "I want to call MCP tool X, from a shell, right now."

## When to use

- Your session has no `mcp__*` tools registered (e.g. a CI runner, a worker session, an ad-hoc bash turn).
- You want to script MCP tool calls in a pipeline.
- The MCP server supports stdio transport (most do; SSE/HTTP transports are a separate path).
- You want to *verify* an MCP works before registering it with `claude mcp add`.

If the server is already loaded into your harness as `mcp__server__tool`, just call it directly — don't reinvent the stdio pipe.

## Protocol summary (MCP 2024-11-05)

Three-step handshake, then arbitrary `tools/list` / `tools/call`:

```
1.  request  initialize          → response with serverInfo + capabilities
2.  notify    notifications/initialized  (no response, just a fire-and-forget)
3.  request  tools/list          → response with tool schemas
    request  tools/call          → response with content blocks
```

All frames are single-line JSON. One request → one response, matched by `id`. Notifications (no `id`) get no reply. Use `select()` or non-blocking reads to avoid deadlock when the server logs to stderr.

### Frame shapes

```json
// request
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}

// notification
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}

// success response
{"jsonrpc":"2.0","id":1,"result":{...}}

// error response
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}
```

`tools/call` result is `result.content` — an array of content blocks. **Text blocks are stringified JSON** that you must re-parse:

```json
{"result":{"content":[{"type":"text","text":"{\n  \"organic\": [...]\n}"}]}}
```

## Install the launcher

MCP servers are usually published as a Python or Node package with a `command` entry point.

| Ecosystem | Install | Spawn command |
|---|---|---|
| PyPI (`uvx`) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` (one-time) | `uvx --from <pkg> <entrypoint> -y` |
| npm (`npx`) | comes with Node | `npx -y <pkg>` |

`uvx` and `npx` both (1) create an ephemeral venv/cache, (2) install the package on first run, (3) execute the entrypoint, (4) clean up on exit. The `-y` flag auto-confirms any "install?" prompt.

After installing `uvx`, verify with `which uvx` → expect a path like `/home/<user>/.local/bin/uvx`.

## Generic Python harness

Drop this into a script and point it at any stdio MCP server. Replace `COMMAND`, `ENV`, and the tool name you want to call.

```python
# mcp_invoke.py — minimal MCP stdio client
import json, os, subprocess, sys, time, select

COMMAND = ["uvx", "--from", "<PACKAGE>", "<ENTRYPOINT>", "-y"]  # e.g. uvx --from minimax-coding-plan-mcp minimax-coding-plan-mcp -y
ENV_OVERRIDES = {  # MCP-specific env vars; the server reads these
    # "API_KEY_ENV_NAME": "sk-...",
    # "BASE_URL_ENV_NAME": "https://...",
}

def call_tool(name, arguments, *, timeout=60):
    env = os.environ.copy()
    env.update(ENV_OVERRIDES)

    proc = subprocess.Popen(
        COMMAND,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, text=True, bufsize=1,
    )

    def send(req):
        proc.stdin.write(json.dumps(req) + "\n"); proc.stdin.flush()
    def recv(timeout_s=timeout):
        end = time.time() + timeout_s
        while time.time() < end:
            r,_,_ = select.select([proc.stdout], [], [], 0.5)
            if r:
                line = proc.stdout.readline()
                if line: return json.loads(line)
        raise TimeoutError("no MCP response")

    try:
        send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2024-11-05",
            "capabilities":{},
            "clientInfo":{"name":"mcp-invoke","version":"0.1.0"},
        }})
        recv()                                # initialize result

        send({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})

        send({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
            "name": name, "arguments": arguments,
        }})
        return recv()
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill()

if __name__ == "__main__":
    result = call_tool("<tool_name>", {"<arg>": "<value>"})
    print(json.dumps(result, ensure_ascii=False, indent=2))
```

### Discovery variant: list tools first

If you don't know the tool names, swap the `tools/call` for `tools/list`:

```python
send({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
tools_resp = recv()
for t in tools_resp["result"]["tools"]:
    print(t["name"], "—", t.get("description","")[:80])
```

Then drive `tools/call` based on what you see.

## Worked example: MiniMax Token Plan MCP

Verified end-to-end on 2026-06-10 in an imac-test session that had no MCP auto-loaded.

| Field | Value |
|---|---|
| Package | `minimax-coding-plan-mcp` (PyPI) |
| Server | `Minimax v1.27.2`, protocol `2024-11-05` |
| Env vars | `MINIMAX_API_KEY` (required), `MINIMAX_API_HOST` (default `https://api.minimaxi.com`), `MINIMAX_MCP_BASE_PATH` (local output dir, must exist + writable), `MINIMAX_API_RESOURCE_MODE` (`url` / `local`) |
| Tools | `web_search(query)`, `understand_image(prompt, image_url)` |

**Spawn command:**
```bash
MINIMAX_API_KEY="sk-cp-..." \
MINIMAX_API_HOST="https://api.minimaxi.com" \
MINIMAX_MCP_BASE_PATH="$TMPDIR/mcp-out" \
MINIMAX_API_RESOURCE_MODE="url" \
uvx --from minimax-coding-plan-mcp minimax-coding-plan-mcp -y
```

**Call shape (`web_search`):**
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"web_search",
  "arguments":{"query":"<3-5 keywords, include date for time-sensitive>"}
}}
```

**Response shape (`web_search` result is a stringified JSON inside `content[0].text`):**
```json
{
  "result": {
    "content": [
      {"type": "text", "text": "{\"organic\":[{\"title\":...,\"link\":...,\"snippet\":...,\"date\":...}],\"related_searches\":[...],\"base_resp\":{...}}"}
    ]
  }
}
```
So: `r["result"]["content"][0]["text"]` → `json.loads(...)` → `organic[]`.

Real latency observation: `web_search` for a current-events query round-trips in **5–15 s** (it's a search backend call, not local compute).

## Recipe: register for future sessions (optional)

Once you've verified the server works over stdio, you can pin it to user-level Claude Code so future sessions auto-load it. The `update-config` skill (or `claude mcp add` on the CLI) writes `~/.claude.json`:

```bash
claude mcp add -s user MiniMax \
  --env MINIMAX_API_KEY=sk-cp-... \
  --env MINIMAX_API_HOST=https://api.minimaxi.com \
  -- uvx minimax-coding-plan-mcp -y
```

After this, **new** sessions get `mcp__MiniMax__web_search` and `mcp__MiniMax__understand_image` tools. The current session won't pick it up — MCPs are loaded at Claude Code startup.

## Common pitfalls

- **No response, then timeout** — server is waiting for the `initialized` notification and you didn't send it. Always send the notification between `initialize` and any other request.
- **Method not found (`-32601`)** — wrong protocol version in `initialize`. `2024-11-05` is the current default; some older servers want `2024-10-07` or `2025-03-26`. Check the server's docs.
- **Response looks like a dict, not a list** — you got a `result` object; the actual tool output is `result.content[0].text` (always a string, often JSON inside).
- **Stderr is silent** — many MCP servers log useful info (retry counts, rate limits) to stderr. Tee it: `stderr=subprocess.PIPE` and read on timeout.
- **Env var not picked up** — servers usually read env only at startup. Set them *before* spawning. Mutating `os.environ` after `Popen` is too late.
- **`uvx` not found** — install with the one-liner above; it lands in `~/.local/bin/uvx`, which is not on every shell's default `PATH`. Prefix `export PATH="$HOME/.local/bin:$PATH"`.
- **Server hangs after first call** — JSON-RPC needs newline-delimited frames. `text=True, bufsize=1` and a `"\n"` after every `json.dumps(req)` are mandatory.
- **Output files cluttering the repo** — `MINIMAX_MCP_BASE_PATH` defaults to `./.trash` for the MiniMax MCP; point it at `$TMPDIR/...` (会话专属临时目录, 唯一可被前端展示的位置) or your `.imac/scratch/` to keep the project clean.
- **Auth key leakage in logs** — many MCP servers log the env var name (not the value) on startup. Fine, but don't `set -x` the parent shell if the value is sensitive.

## Pattern: shell-only quick call

If you don't want a Python script, you can drive the JSON-RPC stream straight from bash with `jq` + heredocs. Less robust (no error handling) but useful for one-offs:

```bash
KEY="sk-cp-..."
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"today news"}}}'
  sleep 20
} | MINIMAX_API_KEY="$KEY" MINIMAX_API_HOST="https://api.minimaxi.com" \
  MINIMAX_MCP_BASE_PATH="$TMPDIR/mcp-out" \
  uvx --from minimax-coding-plan-mcp minimax-coding-plan-mcp -y \
  2>/dev/null | head -1
```

The first line of stdout is the `initialize` response; you'll need a longer-lived pipe (e.g. `coproc` or a temp file per request) to map request ids to responses properly. **Use the Python harness for anything non-trivial.**

## Generalizing beyond MiniMax

The exact same recipe works for any stdio MCP server. Substitutions:

| What you change | Where |
|---|---|
| `COMMAND` list | `["uvx", "--from", "<pkg>", "<entry>", "-y"]` or `["npx", "-y", "<pkg>"]` |
| `ENV_OVERRIDES` | whatever env vars the server's docs list (auth keys, base URLs, output paths) |
| `name` in `tools/call` | the tool name from `tools/list` |
| `arguments` in `tools/call` | the JSON schema from `tools/list` |

If `tools/list` returns nested argument schemas (objects, enums, arrays), feed them straight into the `arguments` dict — the harness serializes them for you.

## When **not** to use this

- The MCP server is HTTP/SSE transport, not stdio. The handshake is different; you'll need an HTTP client.
- The server requires OAuth / dynamic client registration. Stdio servers usually take a static API key; OAuth servers (e.g. some Google/Microsoft ones) need a token-refresh loop.
- The tool produces binary outputs (audio, video, images). Stdio JSON-RPC can carry base64, but it's clumsy — for big media, prefer the underlying HTTP API directly.
- You're already in a session where the MCP is auto-loaded. Just use the registered `mcp__server__tool` — no subprocess needed.
