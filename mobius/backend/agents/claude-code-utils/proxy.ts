/**
 * claude-code-utils/proxy.ts — The proxy tier of a claude session.
 *
 * One decision point (resolveClaudeProxyMode) plus the prerequisite checks
 * that keep a proxied session from silently starting direct. Dispatch and
 * spawn both call the same functions, which is what stops forceNoProxy /
 * useProxy / proxyMode from contradicting each other within one session.
 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

import { HOME, PROXY_CONF, PROXY_ENVS_FILE, PROXY_ENVS_FILE_LEGACY } from './constants'
import type { ClaudeDispatchOpts } from './types'

/** Proxy tiers a session can run on. */
export type ProxyMode = 'direct' | 'env' | 'proxychains' | 'env_proxychains'

/*
 * Resolve which proxy env-var file counts as configured: the new
 * proxy_envs.conf when present, otherwise the legacy proxy_envs.bash.
 *
 * Only the prereq check asks this; the spawn command tries both names
 * itself, so a host set up before the rename keeps working with no
 * migration.
 */
export function resolveProxyEnvsFile() {
  return fs.existsSync(PROXY_ENVS_FILE) ? PROXY_ENVS_FILE : PROXY_ENVS_FILE_LEGACY
}

/*
 * Normalize the legacy per-session useProxy flag, which arrives from json:
 * a boolean, 0/1, or the strings "0" / "1" / "false" / "true".
 * Anything unrecognized (null, undefined, a stray object) takes the
 * caller's fallback rather than false: in that older data an absent field
 * meant "not configured", not "off".
 */
export function normalizeUseProxy(value: unknown, fallback = true) {
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  return !!fallback
}

/*
 * Normalize the four proxy modes to 'direct' | 'env' | 'proxychains' |
 * 'env_proxychains'.
 *
 * The legacy booleans of rows written before modes existed keep their old
 * meaning: true → 'env_proxychains' (the old env + proxychains double
 * track), false/null → 'direct'. Anything unmapped takes the fallback, so
 * a bad value in a persisted row cannot silently select a proxy path.
 */
export function normalizeProxyMode4(value: unknown, fallback: ProxyMode = 'direct'): ProxyMode {
  if (value === 'env' || value === 'proxychains' || value === 'env_proxychains') return value
  if (value === 'direct') return 'direct'
  if (value === true || value === 1 || value === '1' || value === 'true') return 'env_proxychains'
  if (value === false || value === 0 || value === '0' || value === 'false') return 'direct'
  return fallback
}

/*
 * The single decision point for a session's proxy settings: both dispatch
 * and spawn call it, which is what keeps forceNoProxy / useProxy /
 * proxyMode from ever contradicting each other within one session.
 *
 * forceNoProxy wins outright (mode 'direct'); otherwise the explicit
 * 4-value mode is used, and only a null mode falls back to the legacy
 * useProxy boolean (true → 'env_proxychains', false → 'direct').
 *
 * The returned useProxy is derived from the mode ('direct' ⇔ false) rather
 * than copied from the argument, and fallbackUseProxy supplies the legacy
 * value for an old persisted row that carries neither a mode nor a usable
 * flag.
 */
export function resolveClaudeProxyMode(useProxy: boolean, forceNoProxy: boolean = false, fallbackUseProxy: boolean = false, proxyMode: string | null = null) {
  const forced = !!forceNoProxy
  // 强制直连时不再看任何模式，一律判为direct
  // A forced direct ignores every mode and resolves to 'direct'
  const mode = forced
    ? 'direct'
    : normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, fallbackUseProxy) ? 'env_proxychains' : 'direct')
  return {
    forceNoProxy: forced,
    useProxy: mode !== 'direct',
    proxyMode: mode,
  }
}

/*
 * Which proxy dependencies the given mode is missing, as display strings
 * ("file: ...", "bin (PATH): ..."; [] when complete). env modes need the
 * env-var file, proxychains modes need the proxychains config (new name,
 * legacy proxy_claude.conf accepted) plus the binary on PATH.
 *
 * Returned rather than thrown so both callers can pick their own severity:
 * preflight warns (sessions on other modes still start),
 * assertProxyAvailable fails the spawn.
 */
export function proxyPrereqMissing(mode: string = 'env_proxychains') {
  const missing: string[] = []
  // 只查该模式用到的依赖，没用到的不算缺失
  // Check only what the mode uses, unused deps are not missing
  const needEnv = mode === 'env' || mode === 'env_proxychains'
  const needChains = mode === 'proxychains' || mode === 'env_proxychains'
  if (needEnv && !fs.existsSync(resolveProxyEnvsFile())) missing.push(`file: ${resolveProxyEnvsFile()}`)
  if (needChains) {
    // 旧名配置仍算数，有一个在就算齐
    // The legacy conf name still counts, either file satisfies it
    if (!fs.existsSync(PROXY_CONF) && !fs.existsSync(path.join(HOME, 'proxy_claude.conf'))) missing.push(`file: ${PROXY_CONF}`)
    if (spawnSync('which', ['proxychains']).status !== 0) missing.push('bin (PATH): proxychains')
  }
  return missing
}

/*
 * Throwing wrapper around proxyPrereqMissing for the spawn path: a session
 * configured to go through a proxy must never quietly start up direct,
 * since that would leak the traffic the operator wanted routed, so a
 * missing dependency fails the spawn with the full list.
 * The message names the mode, so it stays clear which one was attempted.
 */
export function assertProxyAvailable(mode: string = 'env_proxychains') {
  const missing = proxyPrereqMissing(mode)
  if (missing.length) throw new Error(`代理依赖缺失 (${mode}): ${missing.join(', ')}`)
}

/*
 * Read the launch fields this backend needs out of a dispatch: model,
 * settingsPath and the proxy trio, plus captureStream. The flat legacy
 * fields (opts.model, opts.useProxy, ...) are only a compatibility
 * fallback for callers that never went through the model registry;
 * modelLaunchOptions wins when it is present.
 *
 * Absent values stay null / false / 'direct' rather than being invented,
 * so the callers, which prefer their persisted runtime row, can tell "not
 * given" from "given as X". Keep useProxy and proxyMode in step: a forced
 * direct pins both.
 */
export function unpackLaunch(opts: ClaudeDispatchOpts) {
  const launch = (opts?.modelLaunchOptions || {}) as Record<string, any>
  // 布尔字段要求严格为true，字符串不算
  // The booleans need a strict true, a string "true" does not count
  return {
    model: launch.model || opts.model || null,
    settingsPath: launch.settingsPath || opts.settingsPath || null,
    useProxy: launch.forceNoProxy ? false : (launch.useProxy === true || opts.useProxy === true),
    proxyMode: launch.forceNoProxy ? 'direct' : (launch.proxyMode || opts.proxyMode || 'direct'),
    forceNoProxy: launch.forceNoProxy === true || opts.forceNoProxy === true,
    captureStream: launch.captureStream === true,
  }
}
