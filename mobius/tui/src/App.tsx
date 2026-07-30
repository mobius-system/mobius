/**
 * App — top-level route machine.
 *
 *   login ──(success / auto-login)──▶ prep ──(preferences ready)──▶ chat
 *                                              chat ──/resume──▶ resume ──pick──▶ chat(resume)
 *                                              chat ──/clear───▶ chat (fresh, remounted)
 *
 * Auto-login: on startup, read ~/.mobius/login.json and validate the token via
 * GET /api/auth/me; on a stale token, re-login with the stored username/password
 * (matching the desktop electron flow). Otherwise show the login form.
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { MobiusClient, getMe, login, ApiError } from './api.js'
import { loadLogin, saveLogin, type LoginRecord } from './config.js'
import { LoginScreen } from './components/Login.js'
import { PrepScreen, type ReadyState } from './components/PrepScreen.js'
import { ChatScreen } from './components/Chat.js'
import { ResumePicker } from './components/ResumePicker.js'
import { Screen } from './components/Screen.js'
import { startAimuxConnection, stopAimuxConnection, type AimuxStatus } from './aimux.js'
import { AimuxStatusLine } from './components/AimuxStatus.js'

type Route = 'boot' | 'login' | 'prep' | 'chat' | 'resume'

export function App() {
  const [route, setRoute] = useState<Route>('boot')
  const [bootMsg, setBootMsg] = useState('初始化…')
  const [client, setClient] = useState<MobiusClient | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<{ server?: string; username?: string }>({})
  const [ready, setReady] = useState<ReadyState | null>(null)
  const [chatKey, setChatKey] = useState(0)
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null)
  const [aimuxStatus, setAimuxStatus] = useState<AimuxStatus>({
    state: process.env.MOBIUS_TUI_DISABLE_AIMUX === '1' ? 'disabled' : 'stopped',
    phase: 'idle',
    detail: process.env.MOBIUS_TUI_DISABLE_AIMUX === '1' ? 'AIMUX 自动连接已关闭' : '登录后自动连接',
  })

  function bootAimux(rec: LoginRecord): void {
    // AIMUX installation/connection is deliberately backgrounded: the TUI can
    // continue into project preparation while a first-time pip install runs.
    void startAimuxConnection({
      server: rec.server,
      token: rec.token,
      onStatus: (status: AimuxStatus) => {
        setAimuxStatus(status)
        if (status.detail) setBootMsg(status.detail)
      },
    }).catch((e: any) => setBootMsg(`AIMUX 启动失败: ${e?.message ?? String(e)}`))
  }

  useEffect(() => () => { void stopAimuxConnection() }, [])

  // ── bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => { (async () => {
    const rec = await loadLogin()
    if (!rec) { setRoute('login'); return }
    setPrefill({ server: rec.server, username: rec.username })
    const c = new MobiusClient(rec.server, rec.token)
    try {
      setBootMsg('校验登录态…')
      const me = await getMe(rec.server, rec.token)
      setUserId(me.id)
      setClient(c); setRoute('prep')
      bootAimux(rec)
    } catch {
      // token expired — try to re-login with stored creds
      if (rec.password) {
        try {
          setBootMsg('登录态已过期，重新登录…')
          const r = await login(rec.server, rec.username, rec.password)
          const updated: LoginRecord = { ...rec, token: r.token, user: r.user }
          await saveLogin(updated)
          setUserId(r.user.id)
          setClient(new MobiusClient(rec.server, r.token))
          setRoute('prep')
          bootAimux(updated)
          return
        } catch { /* fall through to login */ }
      }
      setRoute('login')
    }
  })() }, [])

  // ── handlers ───────────────────────────────────────────────────────────────
  function onLoginSuccess(rec: LoginRecord) {
    setUserId(rec.user.id)
    setClient(new MobiusClient(rec.server, rec.token))
    setRoute('prep')
    bootAimux(rec)
  }

  function onPrepReady(st: ReadyState) {
    setReady(st)
    setResumeSessionId(null)
    setChatKey(k => k + 1)
    setRoute('chat')
  }

  function onClear() {
    if (process.env.MOBIUS_TUI_DEBUG) console.error('[route] clear')
    setResumeSessionId(null)
    setChatKey(k => k + 1) // remount Chat → fresh session on next send
  }

  function onResume() { if (process.env.MOBIUS_TUI_DEBUG) console.error('[route] resume'); setRoute('resume') }

  function onResumed(sid: string) {
    setResumeSessionId(sid)
    setChatKey(k => k + 1)
    setRoute('chat')
  }

  function onQuit() {
    void stopAimuxConnection().finally(() => process.exit(0))
  }

  // ── render ─────────────────────────────────────────────────────────────────
  // The chat screen already pins itself to the terminal height, so render it
  // bare — a <Screen> wrapper would clip its transcript in short terminals and
  // in the non-TTY test harness. Every other route (login, the project/issue/
  // session pickers) renders inside <Screen> so each frame is pinned to the
  // terminal height and transitions stay free of stale-frame residue. See
  // components/Screen.tsx.
  if (route === 'chat' && ready && client) {
    return (
      <ChatScreen
        key={chatKey}
        client={client}
        ready={ready}
        webUserId={ready.project.created_by || userId || ready.issue.created_by || ''}
        resumeSessionId={resumeSessionId}
        onClear={onClear}
        onResume={onResume}
        onQuit={onQuit}
        aimuxStatus={aimuxStatus}
      />
    )
  }
  let node: React.ReactNode
  if (route === 'boot') {
    node = <Box paddingX={2} paddingY={1}><Text color="cyan">{bootMsg}</Text></Box>
  } else if (route === 'login' || !client) {
    node = <LoginScreen onSuccess={onLoginSuccess} />
  } else if (route === 'resume' && ready) {
    node = <Box flexDirection="column"><AimuxStatusLine status={aimuxStatus} compact /><ResumePicker client={client} project={ready.project} onPick={onResumed} onBack={() => setRoute('chat')} /></Box>
  } else {
    node = <Box flexDirection="column"><AimuxStatusLine status={aimuxStatus} compact /><PrepScreen client={client} onReady={onPrepReady} onQuit={onQuit} /></Box>
  }
  return <Screen>{node}</Screen>
}
