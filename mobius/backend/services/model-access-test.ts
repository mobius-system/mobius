import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findClaudeCodeModel, findCodexModel } from './model-access'

export async function testAccessModel(sessionModel: string): Promise<{ ok: boolean; text: string }> {
  const isClaude = sessionModel.startsWith('claude-code:')
  const isCodex = sessionModel.startsWith('codex:')
  if (!isClaude && !isCodex) throw new Error('不支持的模型类型')
  const row = isClaude ? findClaudeCodeModel(sessionModel) : findCodexModel(sessionModel, { includeSecret: true })
  if (!row) throw new Error('模型配置不存在')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-model-test-'))
  const outputPath = path.join(directory, 'response.txt')
  const env = { ...process.env }
  delete env.CLAUDECODE
  if (isCodex && row.secret_env_key && row.secret_value) env[row.secret_env_key] = row.secret_value
  const prompt = 'This is a connection test. Do not use tools. Reply with only: OK'
  const args = isClaude
    ? ['-p', prompt, '--settings', row.settings_path, '--model', row.claude_model,
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--no-session-persistence', '--output-format', 'text']
    : ['exec', '--profile', row.key, '--model', row.codex_model, '--sandbox', 'read-only',
      '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', outputPath,
      '-c', 'features.shell_tool=false', '-c', 'approval_policy="never"', prompt]
  const started = Date.now()
  try {
    return await new Promise(resolve => {
      execFile(isClaude ? 'claude' : 'codex', args, {
        cwd: directory, env, timeout: 90000, maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        const response = isClaude ? stdout.trim() : (fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : '')
        const redact = (value: string) => {
          const secrets = [row.secret_value]
          if (isClaude) {
            try {
              const settings = JSON.parse(fs.readFileSync(row.settings_path, 'utf8'))
              secrets.push(settings.env?.ANTHROPIC_AUTH_TOKEN, settings.env?.ANTHROPIC_API_KEY)
            } catch {}
          }
          return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value).slice(0, 3000)
        }
        if (error) {
          resolve({ ok: false, text: error.killed ? '测试超时（90 秒），请检查网络和模型配置。' : redact(stderr.trim() || error.message) })
        } else if (!response) {
          resolve({ ok: false, text: '进程已退出，但模型未返回文本。' })
        } else {
          resolve({ ok: true, text: `${redact(response)}\n耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒` })
        }
      })
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
