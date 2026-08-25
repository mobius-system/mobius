import * as fs from 'fs';
import * as path from 'path';
import { PORT, MOBIUS_DATA_PATH } from '../config';
import { verifyAgentBridgeToken } from './agent-mention-bridge';

// 跨 Session 桥接 CLI (方案 C: 服务端持凭证, LLM 只表达意图).
// token 永不进 LLM 上下文/转录: mint 时落 MOBIUS_DATA_PATH/agent-bridge-tokens/<id>.token (0600),
// workspace 内只放无秘密的 bridge 脚本, agent 用 `bridge read/accept/reply/...` 操作消息.
// 通道过期/关闭时由 cleanup 顺手删除 token 文件, 零残留.

const BRIDGE_TOKEN_DIR = path.join(MOBIUS_DATA_PATH, 'agent-bridge-tokens');
const BRIDGE_TOKEN_SUFFIX = '.token';
export const BRIDGE_SCRIPT_NAME = 'bridge';

function tokenFilePath(fileId: string): string {
  const safe = fileId.replace(/[^A-Za-z0-9_.-]/g, '');
  if (!safe || safe === '.' || safe === '..' || safe.startsWith('.') || !safe.endsWith(BRIDGE_TOKEN_SUFFIX)) {
    throw new Error(`bridge token 文件 ID 非法: ${fileId}`);
  }
  return path.join(BRIDGE_TOKEN_DIR, safe);
}

function ensureTokenDir(): void {
  fs.mkdirSync(BRIDGE_TOKEN_DIR, { recursive: true });
  try { fs.chmodSync(BRIDGE_TOKEN_DIR, 0o700); } catch {}
}

export type BridgeCredential = {
  /** token 文件名 (含 .token 后缀); 同 channel 反复授权覆盖旧文件. */
  fileName: string;
  /** 所属通道 ID (用于 status 等寻址). */
  channelId: string;
};

/** 把桥接 token 写到服务端受限目录 (0600), LLM 上下文里只出现文件名级别的短 ID. */
export function storeBridgeToken(token: string, channelId: string, suffix = ''): BridgeCredential {
  ensureTokenDir();
  const cleanSuffix = suffix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  const fileName = `${channelId}${cleanSuffix ? `__${cleanSuffix}` : ''}${BRIDGE_TOKEN_SUFFIX}`;
  const file = tokenFilePath(fileName);
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return { fileName, channelId };
}

export function readBridgeToken(fileName: string): string | null {
  try {
    const raw = fs.readFileSync(tokenFilePath(fileName), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** 删除单个 token 文件; 不存在时静默. */
export function removeBridgeToken(fileName: string): void {
  try { fs.unlinkSync(tokenFilePath(fileName)); } catch {}
}

/** 清掉 JWT 已过期或通道已死的 token 文件. 返回删除数. */
export function cleanupBridgeTokens(isChannelAlive: (channelId: string) => boolean): number {
  let removed = 0;
  let entries: string[] = [];
  try { entries = fs.readdirSync(BRIDGE_TOKEN_DIR); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.endsWith(BRIDGE_TOKEN_SUFFIX)) continue;
    const file = path.join(BRIDGE_TOKEN_DIR, entry);
    let alive = false;
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const payload = verifyAgentBridgeToken(raw);
      alive = !!payload && isChannelAlive(payload.channel_id);
    } catch { alive = false; }
    if (!alive) {
      try { fs.unlinkSync(file); removed += 1; } catch {}
    }
  }
  return removed;
}

function shellSingleQuoted(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 无秘密的 bridge CLI 脚本内容: 自己读 token 文件、拼 curl, LLM 只传短数字 ID 和自己的话. */
export function bridgeCliScript(tokenDir: string): string {
  const py = 'python3';
  return [
    '#!/usr/bin/env bash',
    '# Mobius 跨 Session 桥接 CLI (由后端生成, 不含任何秘密).',
    '# 用法:',
    `#   ${BRIDGE_SCRIPT_NAME} whoami                       # 查看凭证文件与通道`,
    `#   ${BRIDGE_SCRIPT_NAME} read <message_id>           # 读外部消息正文`,
    `#   ${BRIDGE_SCRIPT_NAME} accept <message_id>         # 接受; hold|refuse 同理`,
    `#   ${BRIDGE_SCRIPT_NAME} batch                       # 读整批消息`,
    `#   ${BRIDGE_SCRIPT_NAME} batch-accept [id ...]       # 批量决策`,
    `#   ${BRIDGE_SCRIPT_NAME} reply <message_id> "内容"    # 回复对端`,
    `#   ${BRIDGE_SCRIPT_NAME} send "内容"                 # 主动发消息`,
    `#   ${BRIDGE_SCRIPT_NAME} status                      # 通道内消息投递/决策状态`,
    'set -euo pipefail',
    `TOKEN_DIR=${shellSingleQuoted(tokenDir)}`,
    `BASE='http://localhost:${PORT}/api/agent-bridge'`,
    'usage() { sed -n "3,11p" "$0" | sed "s/^# \\{0,1\\}//" >&2; exit 2; }',
    '[ $# -ge 1 ] || usage',
    'cmd="$1"; shift || true',
    // token 文件选择: 默认取目录内唯一 .token; 多通道时用 BRIDGE_TOKEN_FILE=<文件名> 指定.
    'if [ -n "${BRIDGE_TOKEN_FILE:-}" ]; then',
    '  TOKEN_FILE="$TOKEN_DIR/$BRIDGE_TOKEN_FILE"',
    'else',
    '  found=$(ls -1 "$TOKEN_DIR"/*.token 2>/dev/null || true)',
    '  count=$(printf "%s\\n" "$found" | grep -c . || true)',
    '  [ "$count" -ge 1 ] || { echo "bridge: 未找到桥接凭证 (通道可能已过期)" >&2; exit 1; }',
    '  if [ "$count" -gt 1 ]; then',
    '    echo "bridge: 存在多个通道凭证, 请设置 BRIDGE_TOKEN_FILE=<文件名> 后重试:" >&2',
    '    ls -1 "$TOKEN_DIR" | sed "s/^/  /" >&2',
    '    exit 2',
    '  fi',
    '  TOKEN_FILE="$found"',
    'fi',
    `ACTOR="$(${py} -c 'import base64,json,sys; s=open(sys.argv[1]).read().strip().split("."); p=s[1]; print(json.loads(base64.urlsafe_b64decode(p+"="*((4-len(p)%4)%4))).get("actor_session_id",""))' "$TOKEN_FILE" 2>/dev/null || true)"`,
    'CHANNEL_ID="$(basename "$TOKEN_FILE" .token)"; CHANNEL_ID="${CHANNEL_ID%%__*}"',
    'case "$cmd" in',
    '  whoami) echo "token_file=$(basename "$TOKEN_FILE") channel_id=$CHANNEL_ID actor_session_id=$ACTOR"; exit 0;;',
    '  read) [ $# -eq 1 ] || usage; curl -sS "$BASE/messages/$1" -H "Authorization: Bearer $(head -n1 "$TOKEN_FILE")"; echo;;',
    '  accept|hold|refuse)',
    '    [ $# -eq 1 ] || usage',
    `    body="$(${py} -c 'import json,sys; print(json.dumps({"deciding_session_id": sys.argv[1], "decision": sys.argv[2]}))' "$ACTOR" "$cmd")"`,
    '    curl -sS -X POST "$BASE/messages/$1/decision" -H "Authorization: Bearer $(head -n1 "$TOKEN_FILE")" -H "Content-Type: application/json" --data "$body"; echo;;',
    '  batch) curl -sS "$BASE/batch" -H "Authorization: Bearer $(head -n1 "$TOKEN_FILE")"; echo;;',
    '  batch-accept|batch-hold|batch-refuse)',
    '    decision="${cmd#batch-}"',
    `    body="$(${py} -c 'import json,sys; ids=[int(x) for x in sys.argv[3].replace(","," ").split()] if len(sys.argv)>3 and sys.argv[3] else None; print(json.dumps({"deciding_session_id": sys.argv[1], "decision": sys.argv[2], **({"message_ids": ids} if ids else {})}))' "$ACTOR" "$decision" "$*")"`,
    '    curl -sS -X POST "$BASE/batch/decision" -H "Authorization: Bearer $(head -n1 "$TOKEN_FILE")" -H "Content-Type: application/json" --data "$body"; echo;;',
    '  reply|send)',
    '    if [ "$cmd" = reply ]; then [ $# -eq 2 ] || usage; mid="$1"; content="$2"; else [ $# -eq 1 ] || usage; mid=""; content="$1"; fi',
    `    body="$(${py} -c 'import json,sys; tok=open(sys.argv[1]).read().strip(); print(json.dumps({"token": tok, "content": sys.argv[2], **({"in_reply_to_message_id": int(sys.argv[3])} if len(sys.argv)>3 and sys.argv[3] else {})}))' "$TOKEN_FILE" "$content" "$mid")"`,
    // token/正文都在 JSON body 里; from/to 方向由服务端按 token 的 actor 自动定向 (agent-bridge.ts),
    // LLM 无需转录任何长 ID, 也不会在命令行回显 token.
    '    curl -sS -X POST "$BASE/messages" -H "Content-Type: application/json" --data "$body"; echo;;',
    '  status) curl -sS "$BASE/channels/$CHANNEL_ID/messages" -H "Authorization: Bearer $(head -n1 "$TOKEN_FILE")"; echo;;',
    '  *) usage;;',
    'esac',
  ].join('\n');
}

export { bridgeCliScript as buildBridgeCliScript };

/** 把无秘密 bridge 脚本写进 session workspace 的隐藏目录; 返回脚本绝对路径. */
export function writeBridgeCliToWorkspace(workDir: string, hiddenFolderName: string): string {
  const dir = path.join(workDir, hiddenFolderName);
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, BRIDGE_SCRIPT_NAME);
  fs.writeFileSync(scriptPath, bridgeCliScript(BRIDGE_TOKEN_DIR) + '\n', { mode: 0o755 });
  try { fs.chmodSync(scriptPath, 0o755); } catch {}
  return scriptPath;
}
