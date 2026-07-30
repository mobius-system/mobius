/**
 * Login screen.
 *
 * Mirrors the desktop electron login form (desktop/src/login.ts): collect
 * server URL + username + optional password, POST /api/auth/login, persist the
 * result to ~/.mobius/login.json. Password is only required when the server's
 * /api/auth/config reports password_required=true (Mobius defaults to
 * passwordless).
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { TextInput } from './primitives.js'
import { getAuthConfig, login, ApiError } from '../api.js'
import { saveLogin, type LoginRecord } from '../config.js'

const DEFAULT_SERVER = ''

export function LoginScreen({ onSuccess, onError }: {
  onSuccess: (rec: LoginRecord) => void
  onError?: (msg: string) => void
}) {
  const [server, setServer] = useState(DEFAULT_SERVER)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pwdRequired, setPwdRequired] = useState<boolean | null>(null)
  const [focus, setFocus] = useState(0) // 0 server, 1 user, 2 password
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!server.trim()) { setPwdRequired(null); return }
    getAuthConfig(server).then(c => setPwdRequired(!!c.password_required)).catch(() => setPwdRequired(false))
  }, [server])

  async function submit() {
    if (!server.trim()) { setError('请输入服务地址'); setFocus(0); return }
    if (!username.trim()) { setError('请输入用户名'); setFocus(1); return }
    setBusy(true); setError(null)
    try {
      const r = await login(server.trim(), username.trim(), password || undefined)
      const rec: LoginRecord = { server: server.trim().replace(/\/+$/, ''), username: username.trim(), password: password || undefined, token: r.token, user: r.user }
      await saveLogin(rec)
      onSuccess(rec)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : `登录失败: ${e?.message ?? String(e)}`
      setError(msg)
      onError?.(msg)
    } finally {
      setBusy(false)
    }
  }

  const fields = [
    { label: '服务地址', value: server, set: setServer, placeholder: 'https://your-mobius-server.example.com', mask: false },
    { label: '用户名', value: username, set: setUsername, placeholder: 'your-username', mask: false },
    { label: '密码', value: password, set: setPassword, placeholder: pwdRequired === false ? '（此服务器免密，留空即可）' : '••••', mask: true },
  ]

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">╭─ Mobius 登录 ─╮</Text>
      <Text color="gray">连接到 Mobius 服务并保存登录态到 ~/.mobius/login.json</Text>
      <Box marginTop={1} flexDirection="column">
        {fields.map((f, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text color={focus === i ? 'cyan' : 'gray'}>{f.label}{focus === i ? ' ←' : ''}</Text>
            <TextInput
              value={f.value}
              onChange={f.set}
              focused={focus === i}
              mask={f.mask}
              placeholder={f.placeholder}
              onSubmit={() => {
                if (i < fields.length - 1) setFocus(i + 1)
                else submit()
              }}
              onTab={() => setFocus((i + 1) % fields.length)}
            />
          </Box>
        ))}
      </Box>
      {error ? <Text color="red">⚠ {error}</Text> : null}
      {busy ? <Text color="yellow">登录中…</Text> : (
        <Text color="gray">回车提交 · Tab 切换字段 · {pwdRequired === false ? '免密模式' : (pwdRequired === true ? '需要密码' : '')}</Text>
      )}
    </Box>
  )
}
