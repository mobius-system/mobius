/**
 * claude-code-utils/launch-command.ts — Turn a dispatch into the one bash -lc
 * string that starts the claude TUI.
 *
 * The whole launch is a chain of fragments joined with &&, so a failing step
 * stops the exec instead of starting a half-configured agent. Everything that
 * must be visible from inside a sandbox (settings, hook config, MCP config,
 * CLI environment) is written to a path the container mounts at the same
 * absolute path.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { resolveClaudeProxyMode, assertProxyAvailable, type ProxyMode } from './proxy'
import { jsonlPathOf, resolveAimuxBin, shellQuote } from './session-paths'
import { isolationActiveFor, materializeSettingsForSbx, pathVisibleInSandbox, rewriteAimuxBin } from '../../services/user-isolation'
import { ensureSessionWithProxy } from '../../services/model-access'
import { ensureTempRoot } from '../../services/file-access'
import { buildSessionCliEnv, sessionCliEnvExports } from '../../services/session-cli-env'
import {
  injectClaudeReminderHook,
  sessionSettingsPaths,
  ensureSessionSettingsDir,
  writeReminderHookConfig,
} from '../../services/session-hook-inject'
import {
  buildReminderHookCommand,
  reminderHookBaseUrl,
  reminderHookToken,
  CLAUDE_REMINDER_MATCHER,
} from '../../services/session-reminder-hook'
import { bridgeRemoteGuiAvailable } from '../../services/pc-client-context'

const { APP_DIR, JWT_SECRET, PORT: MOBIUS_PORT } = require('../../config')

export interface LaunchInput {
  sessionId: string
  userId?: string
  cwd: string
  flagRoot: string
  model: string | null
  useProxy: boolean
  proxyMode: string | null
  settingsPath: string | null
  captureStream: boolean
  forceNoProxy: boolean
  /** Agent session id to resume; a fresh uuid is generated when absent. */
  agentSessionId?: string | null
  /** Display name written into the withproxy file for the digital-rain view. */
  displayName?: string | null
  aimuxRemoteName?: string
  aimuxGuiAuthorized?: boolean
}

export interface LaunchPlan {
  /** The bash -lc body, ready to wrap in sandboxCommand(). */
  cmd: string
  /** The claude session id: the resumed one, or a fresh uuid. */
  claudeSessionId: string
  /** Effective settings file after withproxy / sandbox materialization / hook injection. */
  settingsPath: string | null
  /** Per-session withproxy file, deleted on terminate; null when captureStream is off. */
  withProxyPath: string | null
  useProxy: boolean
  proxyMode: ProxyMode
  forceNoProxy: boolean
}

/*
 * Build the claude settings file for this session, in the order the three
 * transforms depend on each other:
 *   1. captureStream: derive a per-session withproxy file from the model settings
 *   2. sandbox: rewrite 127.0.0.1 to the sandbox gateway and copy into a
 *      container-visible path (never fall back to the host path)
 *   3. remote target: copy again into the project hidden folder with the
 *      reminder hook injected (it must be the LAST copy: adding a hook to a
 *      file the sandbox cannot write would break the session)
 * Returns the effective path plus the withproxy path to clean up later.
 */
function prepareSettings(input: LaunchInput): { settingsPath: string | null; withProxyPath: string | null } {
  // settingsPath转成绝对路径，后面的bash命令不受cwd影响
  // Resolve settingsPath absolute so later bash commands stay cwd-independent
  let settingsPath = input.settingsPath ? path.resolve(input.settingsPath) : null
  // 数字雨模式在启动时就生成带sessionId/agent的withproxy文件
  // Digital-rain mode writes the per-session withproxy file right at spawn
  let withProxyPath: string | null = null
  if (input.captureStream && settingsPath) {
    try {
      withProxyPath = ensureSessionWithProxy(settingsPath, { sessionId: input.sessionId, agent: input.displayName || null })
      settingsPath = withProxyPath
    } catch (e: any) {
      // 生成失败只告警，回落原settings，别拦下整个启动
      // A failed withproxy only warns and falls back, it must not block the spawn
      console.warn(`[tmux-claude-code] per-session withproxy 生成失败, 回落原 settings (${input.sessionId}): ${e?.message || e}`)
      withProxyPath = null
    }
  }
  // settings文件缺失直接报错，避免悄悄用默认配置启动
  // A missing settings file is fatal, never silently start on the default config
  if (settingsPath && !fs.existsSync(settingsPath)) {
    throw new Error(`Claude Code settings 文件不存在: ${settingsPath}`)
  }
  // 隔离用户: settings 物化到容器 HOME (token-proxy 地址改沙箱网关), 容器内读容器版
  // Isolated users read a container-side copy with the token-proxy address rewritten
  const sbxSettings = materializeSettingsForSbx(input.userId, input.sessionId, settingsPath)
  if (sbxSettings) settingsPath = sbxSettings
  // 有远端目标才装提醒钩子: 会话级配置放在项目隐藏目录 (宿主与沙箱同一路径)
  // Install the reminder hook only for remote-target sessions; the per-session files
  // live under the project hidden folder, visible at the same path in sandboxes.
  if (input.aimuxRemoteName && input.userId && settingsPath) {
    try {
      const paths = sessionSettingsPaths(input.flagRoot, input.sessionId)
      ensureSessionSettingsDir(paths.dir)
      // 钩子配置落文件: 会话被重开时环境变量可能丢失, 文件仍在
      // Hook config lives in a file: a respawned agent may lose the env vars
      const hookConfigPath = writeReminderHookConfig(paths.hookConfigPath, {
        base_url: reminderHookBaseUrl({ isolated: isolationActiveFor(input.userId), backendPort: MOBIUS_PORT }),
        session_id: input.sessionId,
        token: reminderHookToken(input.sessionId, JWT_SECRET),
      })
      const hookCommand = buildReminderHookCommand({
        cliPath: path.join(APP_DIR, 'mobius', 'scripts', 'cli', 'mobius_session_reminder'),
        configPath: hookConfigPath,
      })
      settingsPath = injectClaudeReminderHook({
        sourcePath: settingsPath,
        destPath: paths.settingsPath,
        command: hookCommand,
        matcher: CLAUDE_REMINDER_MATCHER,
        timeoutSeconds: 5,
      })
    } catch (e: any) {
      // fail fast: 钩子配置写不进项目目录就不启动, 不静默降级
      // Fail fast: if the hook config cannot be written, refuse to start.
      throw new Error(`reminder hook 注入失败 (${input.sessionId}): ${e?.message || e}`)
    }
  }
  return { settingsPath, withProxyPath }
}

/*
 * Write the per-session MCP config and return its path, or null when there is
 * nothing to inject. The file sits next to the session settings under the
 * project hidden folder, so host and sandbox agree on one path; a failed
 * write fails the spawn, because a session without its MCP tools is not the
 * session the user asked for.
 */
function writeMcpConfig(flagRoot: string, sessionId: string, mcpServers: Record<string, any>): string | null {
  if (Object.keys(mcpServers).length === 0) return null
  // 注入的MCP按会话各写一个配置文件，不加--strict-mcp-config
  // MCP servers are injected via one config file per session, not strict mode
  // 这样传入的server算已信任，不会再弹.mcp.json信任框
  // Servers passed this way count as trusted, so no .mcp.json dialog appears
  const mcpPaths = sessionSettingsPaths(flagRoot, sessionId)
  ensureSessionSettingsDir(mcpPaths.dir)
  try {
    // ✨ 把 MCP 定义落到宿主与沙箱同路径的会话目录
    // Write the MCP definitions where host and sandbox agree ✨
    fs.writeFileSync(mcpPaths.mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 })
  } catch (e: any) {
    // fail fast: 配置写不进项目目录就不启动, 不静默降级
    // Fail fast: if the config cannot be written, refuse to start.
    throw new Error(`MCP 配置写入失败 (${mcpPaths.mcpConfigPath}): ${e?.message || e}`)
  }
  return mcpPaths.mcpConfigPath
}

/*
 * Build the aimux MCP server definition for a session bound to a remote.
 * The server is a stdio child of claude, so a user-local host binary must be
 * replaced by the one the image installs before the argv leaves the host.
 */
async function buildAimuxMcpServer(sessionId: string, userId: string | undefined, remoteName: string, guiAuthorized: boolean | undefined) {
  const args = ['mcp', 'serve', '--remote', remoteName]
  // 告诉 aimux MCP 它属于哪个 mobius 会话：remote_set_remote_workdir 设的默认工作目录
  // 按 (mobius 会话 × bridge client) 记录，只有带上会话 id 才谈得上"属于这个会话"，
  // 也才能跨 MCP 重启保留。
  // Tell the aimux MCP which mobius session it belongs to: the default set by
  // remote_set_remote_workdir is keyed by (mobius session, bridge client), and
  // only with the id does it survive an MCP restart inside that session.
  args.push('--mobius-session', sessionId)
  // GUI 会话: 远端当前真的报 gui.available 才上 classic-and-gui; 否则退回 classic,
  // 不能让整个 aimux MCP 因 fail-fast 挂掉 (remote_* 也没了).
  // GUI session: only serve the gui toolset when the remote currently reports
  // gui.available; otherwise fall back to classic so the whole MCP never dies.
  if (guiAuthorized) {
    const guiOk = await bridgeRemoteGuiAvailable(remoteName)
    if (guiOk) args.push('--toolset', 'classic-and-gui')
    else console.warn(`[tmux-claude-code] session authorized GUI but remote ${remoteName} has gui off; serving classic toolset`)
  }
  return { command: rewriteAimuxBin(userId, resolveAimuxBin()), args }
}

/*
 * Assemble the claude argv and the environment chain for one spawn.
 *
 * Resume is opportunistic: an agentSessionId whose jsonl is not visible under
 * this cwd is warned about and degraded to a fresh session, because an old
 * SDK-chain transcript may live elsewhere. Otherwise --resume reuses that id,
 * while a new session binds a fresh uuid via --session-id.
 *
 * --settings is passed in both proxy branches on purpose — the proxied one
 * once omitted it, silently dropping a session's settings file back to the
 * global default.
 */
export async function buildClaudeLaunch(input: LaunchInput): Promise<LaunchPlan> {
  // 隔离用户: cwd 与会话配置根必须落在沙箱挂载范围内, 否则容器里看不到配置/目录
  // Isolated users: cwd and the session-config root must sit inside the sandbox mounts
  if (input.userId && isolationActiveFor(input.userId)) {
    if (!pathVisibleInSandbox(input.userId, input.cwd)) {
      throw new Error(`会话目录不在沙箱挂载范围内, 容器内不可见: ${input.cwd}`)
    }
    if (!pathVisibleInSandbox(input.userId, input.flagRoot)) {
      throw new Error(`会话配置目录不在沙箱挂载范围内, 容器内不可见: ${input.flagRoot}`)
    }
  }
  const { settingsPath: finalSettingsPath, withProxyPath } = prepareSettings(input)

  // 代理档位与settings互相独立，代理分支一样要传--settings
  // Proxy tier and settings are independent; the proxy branch passes settings too
  const proxy = resolveClaudeProxyMode(!!input.useProxy, !!input.forceNoProxy, false, input.proxyMode ?? null)
  // 走代理先查该档依赖，缺依赖直接失败不静默直连
  // A proxied spawn checks its tier's deps and fails, never goes direct
  if (proxy.useProxy) assertProxyAvailable(proxy.proxyMode)

  // 有agentSessionId说明调用方要恢复旧会话
  // A non-null agentSessionId means the caller wants to resume an old session
  let useResume = !!input.agentSessionId
  // 旧SDK链路的jsonl可能不在本cwd下，恢复前先核实
  // An old SDK-chain jsonl may sit outside this cwd, so verify before resuming
  if (useResume && input.agentSessionId && !fs.existsSync(jsonlPathOf(input.cwd, input.agentSessionId, input.userId))) {
    // jsonl不在就告警降级为新会话，恢复不可信
    // A missing jsonl warns and degrades to a new session, resume is untrustworthy
    console.warn(`[tmux-claude-code] resume target jsonl 不存在 (${input.agentSessionId}), fallback 为新 session`)
    // 关掉恢复分支，下面会生成新的claude会话id
    // Turn resume off; a fresh claude session id is generated below
    useResume = false
  }
  // 恢复沿用旧id，新会话生成新uuid
  // Resume reuses the old id, a new session gets a fresh uuid
  const claudeSessionId = useResume ? input.agentSessionId! : crypto.randomUUID()

  // 常禁这三个工具，agent才不会停下来等人或卡在plan模式
  // Always ban these three so the agent never waits on a human or plan mode
  const disallowedTools = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']

  const mcpServers: Record<string, any> = {}
  // 给TUI会话注入aimux远程MCP，让claude驱动远端机器
  // TUI sessions get the aimux remote MCP server injected
  if (input.aimuxRemoteName) {
    mcpServers.aimux = await buildAimuxMcpServer(input.sessionId, input.userId, input.aimuxRemoteName, input.aimuxGuiAuthorized)
  }
  const mcpConfigPath = writeMcpConfig(input.flagRoot, input.sessionId, mcpServers)

  // 拼接交给claude CLI的参数表
  // Assemble the argument list handed to the claude CLI
  const claudeArgs = [
    // 跳过权限询问，后台agent才能自主干活
    // Skip permission prompts so the background agent can act on its own
    `--dangerously-skip-permissions`,
    `--disallowedTools ${disallowedTools.join(',')}`,
    // 恢复用--resume，新会话用--session-id绑一个固定id
    // --resume for a resume, --session-id to bind a fresh session
    useResume ? `--resume ${claudeSessionId}` : `--session-id ${claudeSessionId}`,
  ]
  // 调用方指定了model才追加--model，值做shell转义
  // Append a shell-quoted --model only when the caller pinned one
  if (input.model) claudeArgs.push(`--model ${shellQuote(input.model)}`)
  if (mcpConfigPath) claudeArgs.push(`--mcp-config ${shellQuote(mcpConfigPath)}`)
  // 优先调用方给的settings文件，否则用Mobius默认settings
  // Prefer the caller's settings file, else the Mobius default settings
  const settingsArg = finalSettingsPath
    ? `--settings ${shellQuote(finalSettingsPath)}`
    : `--settings "$HOME/.claude/mobiusdefault.settings.json"`

  // 会话级 CLI 环境: PATH + 后端地址 + 令牌, 宿主与沙箱只差一个地址
  // Per-session CLI env: PATH, backend address and token; host and sandbox differ only in address
  const cliEnv = input.userId
    ? buildSessionCliEnv({ userId: String(input.userId), sessionId: input.sessionId, isolated: isolationActiveFor(input.userId) })
    : null

  // bash -lc链的片段，null项在下面被过滤掉
  // Fragments of the bash -lc chain; null entries are filtered out below
  const fragments: Array<string | null> = [
    ...(cliEnv ? sessionCliEnvExports(cliEnv) : []),
    // env档位才加载环境变量代理，新文件名优先旧.bash兜底
    // Only the env tiers source the env proxy; new name first, legacy .bash second
    (proxy.proxyMode === 'env' || proxy.proxyMode === 'env_proxychains')
      ? `set -a && (source "$HOME/proxy_envs.conf" 2>/dev/null || source "$HOME/proxy_envs.bash") && set +a`
      : null,
    // 清掉VS Code的IPC环境变量，避免CLI误连宿主机IDE
    // Clear the VS Code IPC env so the CLI cannot attach to a host IDE
    `unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN`,
    // 标记进程跑在受控沙箱里
    // Mark the process as running in a controlled sandbox
    `export IS_SANDBOX=1`,
    // 向会话内 CLI 暴露最小身份上下文，用于本机 API 签发用户 JWT
    // Expose minimal Session identity so in-agent CLIs can obtain a user-scoped localhost JWT
    `export MOBIUS_SESSION_ID=${shellQuote(input.sessionId)} MOBIUS_USER_ID=${shellQuote(input.userId || '')}`,
    // 临时目录指向本人的 per-user temp 根, agent 产物 (截图/录屏) 才会落在
    // 权限表放行的位置; 与 file-access.tempRootFor 同口径, 别写死路径
    // Point TMPDIR at the subject's per-user temp root so agent artifacts land
    // where the permission table expects them; same source as file-access.tempRootFor
    `export TMPDIR=${shellQuote(ensureTempRoot(input.userId))}`,
    // 每轮检查点就刷转录，原来是异步攒批约100ms
    // Flush the transcript at turn checkpoints instead of async batching
    `export CLAUDE_CODE_EAGER_FLUSH=1`,
    // 直连档直接exec，代理档套一层proxychains
    // direct/env exec bare, the proxychains tiers wrap the exec
    // 两分支都必带settingsArg，代理档曾漏传会静默回落全局配置
    // Both branches must pass settingsArg; the proxied one once dropped it
    (proxy.proxyMode === 'proxychains' || proxy.proxyMode === 'env_proxychains')
      ? `exec proxychains -q -f "$HOME/proxychains_config_for_llm_models.conf" claude ${settingsArg} ${claudeArgs.join(' ')}`
      : `exec claude ${settingsArg} ${claudeArgs.join(' ')}`,
  ]

  return {
    // 丢掉空片段后用&&串联，任一步失败即中断整条链
    // Drop empty fragments and join with &&, so a failed step stops the chain
    cmd: fragments.filter(Boolean).join(' && '),
    claudeSessionId,
    settingsPath: finalSettingsPath,
    withProxyPath,
    useProxy: proxy.useProxy,
    proxyMode: proxy.proxyMode,
    forceNoProxy: proxy.forceNoProxy,
  }
}
