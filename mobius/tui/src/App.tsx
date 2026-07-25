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
    process.exit(0)
  }

  // ── render ─────────────────────────────────────────────────────────────────
  if (route === 'boot') {
    return <Box paddingX={2} paddingY={1}><Text color="cyan">{bootMsg}</Text></Box>
  }
  if (route === 'login' || !client) {
    return <LoginScreen onSuccess={onLoginSuccess} />
  }
  if (route === 'prep' || !ready) {
    return <PrepScreen client={client} onReady={onPrepReady} />
  }
  if (route === 'resume') {
    return <ResumePicker client={client} project={ready.project} onPick={onResumed} onBack={() => setRoute('chat')} />
  }
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
    />
  )
}
