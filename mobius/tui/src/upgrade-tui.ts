import { execFile } from 'node:child_process'
import { readFile, realpath, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TUI_PACKAGE_NAME, TUI_VERSION } from './version.js'

const REGISTRY = 'https://registry.npmjs.org/'
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
export type UpgradeRunner = (args: string[], timeout: number) => Promise<string>
export interface TuiUpgradeStatus { state: 'running' | 'success' | 'error'; detail: string }

// Use the prefix containing THIS installation, never npm's possibly unrelated
// configured default. Source checkouts, npx caches and pnpm stores are not global installs.
export function installationPrefix(root: string, platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const normalized = p.normalize(root)
  const suffix = p.join(...(platform === 'win32' ? [] : ['lib']), 'node_modules', '@mobius-os', 'mobius')
  if (!normalized.endsWith(p.sep + suffix) || /[\\/](_npx|\.pnpm)[\\/]/.test(normalized)) {
    throw new Error('当前 TUI 不是 npm 全局安装版，请先用 npm install -g @mobius-os/mobius@latest 安装，再运行 mobius。源码目录不会被覆盖。')
  }
  return normalized.slice(0, -suffix.length).replace(/[\\/]$/, '') || p.parse(normalized).root
}

async function npmCommand(): Promise<{ command: string; prefix: string[] }> {
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] }
  // Avoid shell:true / cmd quoting. npm.cmd cannot be execFile'd directly.
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)]
  for (const dir of dirs) {
    const cli = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    try { await access(cli); return { command: process.execPath, prefix: [cli] } } catch { /* next */ }
  }
  throw new Error('找不到 npm，请安装包含 npm 的 Node.js 后重试。')
}

const runNpm: UpgradeRunner = async (args, timeout) => {
  const { command, prefix } = await npmCommand()
  return new Promise((resolve, reject) => {
    execFile(command, [...prefix, ...args], {
      cwd: path.dirname(process.execPath), timeout, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().slice(-1600)
        reject(new Error(detail))
      } else resolve(stdout.trim())
    })
  })
}

export async function performTuiUpgrade(
  report: (status: TuiUpgradeStatus) => void,
  options: { root?: string; platform?: NodeJS.Platform; run?: UpgradeRunner; currentVersion?: string } = {},
): Promise<void> {
  const root = await realpath(options.root ?? PACKAGE_ROOT)
  const prefix = installationPrefix(root, options.platform)
  const run = options.run ?? runNpm
  report({ state: 'running', detail: '正在查询 npm 上的最新 TUI 版本…' })
  const latest = JSON.parse(await run(['view', `${TUI_PACKAGE_NAME}@latest`, 'version', '--json', '--registry', REGISTRY], 60_000))
  if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) {
    throw new Error('npm 返回的 TUI 版本无效，请稍后重试。')
  }
  const current = options.currentVersion ?? TUI_VERSION
  const currentParts = current.split('.').map(Number)
  const latestParts = latest.split('.').map(Number)
  const firstDifference = currentParts.findIndex((part, i) => part !== latestParts[i])
  const newerLocal = /^\d+\.\d+\.\d+$/.test(current) && /^\d+\.\d+\.\d+$/.test(latest)
    && firstDifference >= 0 && currentParts[firstDifference] > latestParts[firstDifference]
  if (latest === current || newerLocal) {
    report({ state: 'success', detail: newerLocal ? `当前 TUI v${current} 高于 npm 最新版 v${latest}，无需升级。` : `TUI v${current} 已是最新版本。` })
    return
  }
  report({ state: 'running', detail: `正在升级 TUI：v${current} → v${latest}，请勿退出…` })
  await run(['install', '--global', '--prefix', prefix, `${TUI_PACKAGE_NAME}@${latest}`, '--registry', REGISTRY, '--no-audit', '--no-fund', '--prefer-online'], 600_000)
  const installed = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (installed.version !== latest) throw new Error(`安装后版本校验失败：期望 ${latest}，实际 ${installed.version}。`)
  report({ state: 'success', detail: `TUI v${latest} 已安装。输入 /quit 后重新运行 mobius 生效，可用 /resume 恢复会话。` })
}

let upgrading = false
export async function upgradeTui(report: (status: TuiUpgradeStatus) => void): Promise<void> {
  if (upgrading) return
  upgrading = true
  try { await performTuiUpgrade(report) }
  catch (error) { report({ state: 'error', detail: `TUI 升级失败：${error instanceof Error ? error.message : String(error)}` }) }
  finally { upgrading = false }
}
