import { useState, useEffect, useRef } from 'react'
import { Lock } from 'lucide-react'
import { useStore, api } from '../store'
import { MobiusLogo } from '../components/mobius-logo'
import { THEME_NAMES } from '../theme'
import { setNormalUserAccessBlocked, useNormalUserAccessBlocked } from '../services/normal-user-access'

function readSafeNextPath() {
  const raw = new URLSearchParams(window.location.search).get('next') || ''
  if (!raw) return ''
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return ''
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return ''
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return ''
  }
}

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [passwordRequired, setPasswordRequired] = useState(false)
  // 临时措施 (2026-10-13): 普通用户全站封禁 — 登录口默认收起, 只留一个「管理员登录」小入口.
  const [adminLoginVisible, setAdminLoginVisible] = useState(false)
  const { setAuth, theme, backgroundFlowEnabled, branding } = useStore()
  const normalUserAccessBlocked = useNormalUserAccessBlocked()
  const usernameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMounted(true)
    setTimeout(() => usernameRef.current?.focus(), 400)
    api('/api/auth/config')
      .then((r: { password_required?: boolean; normal_user_access_blocked?: boolean }) => {
        setPasswordRequired(!!r.password_required)
        setNormalUserAccessBlocked(!!r.normal_user_access_blocked)
      })
      .catch(() => setPasswordRequired(false))
  }, [])

  useEffect(() => {
    if (adminLoginVisible) setTimeout(() => usernameRef.current?.focus(), 200)
  }, [adminLoginVisible])

  // Apply theme to document
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove(...THEME_NAMES)
    root.classList.add(theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('mobius-bg-flow', backgroundFlowEnabled)
  }, [backgroundFlowEnabled])

  const login = async () => {
    if (!username.trim()) { setErr('请输入账户名'); return }
    if (passwordRequired && !password) { setErr('请输入密码'); return }
    setLoading(true); setErr('')
    try {
      const body: Record<string, string> = { username: username.trim().toLowerCase() }
      if (passwordRequired) body.password = password
      const r = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setAuth(r.token, r.user)
      const nextPath = readSafeNextPath()
      if (nextPath) window.location.assign(nextPath)
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      setErr(message || (passwordRequired ? '账户名或密码错误' : '账户名错误'))
    } finally {
      setLoading(false)
    }
  }

  // 临时措施 (2026-10-13) 生效时, 登录界面只留封禁说明: 普通用户入口整体隐藏,
  // 只保留一个低调的「管理员登录」链接给管理员复核使用.
  const showBlockedNotice = normalUserAccessBlocked && !adminLoginVisible

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden select-none"
      style={{ background: 'var(--bg-secondary)' }}>

      {/* ChatGPT 风格: 去掉 radial glow / noise / 顶部高光线, 只留底色 */}

      {/* ── 主内容 ── */}
      <div className={`w-full max-w-[380px] px-6 relative z-10 transition-all duration-1000 ease-out ${
        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
      }`}>

        {/* Logo */}
        <div className="text-center mb-12">
          {!branding.hideLogo && (
            <div className="inline-block mb-6">
              <MobiusLogo size={64} />
            </div>
          )}
          {branding.systemNameEn && (
            <h1 className="text-[length:var(--fs-2xl)] font-semibold tracking-tight mb-2"
              style={{ color: theme !== 'light' ? '#ffffff' : '#1e293b' }}>
              {branding.systemNameEn}
            </h1>
          )}
          {branding.systemNameZh && (
            <p className="text-[length:var(--fs-lg)]" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b' }}>
              {branding.systemNameZh}
            </p>
          )}
        </div>

        {showBlockedNotice ? (
          <div className="rounded-2xl border px-6 py-7 text-center"
            style={{
              background: theme !== 'light' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
              borderColor: theme !== 'light' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
            }}>
            <span className="mb-4 inline-grid h-11 w-11 place-items-center rounded-xl"
              style={{ background: 'rgba(59,130,246,0.12)', color: '#60a5fa' }}>
              <Lock className="h-5 w-5" />
            </span>
            <h2 className="text-[length:var(--fs-2xl)] font-semibold mb-2"
              style={{ color: theme !== 'light' ? '#ffffff' : '#1e293b' }}>
              普通用户访问已暂时关闭
            </h2>
            <p className="text-[length:var(--fs-lg)] leading-6 mb-1"
              style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b' }}>
              {branding.systemNameZh || branding.systemNameEn || '小莫'} 正在做一次安全加固，期间普通用户暂时无法登录和使用。
            </p>
            <p className="text-[length:var(--fs-md)] leading-5"
              style={{ color: theme !== 'light' ? '#6b7280' : '#94a3b8' }}>
              这是临时措施，恢复后会立即放开，无需你做任何操作。
            </p>
            <button
              type="button"
              onClick={() => setAdminLoginVisible(true)}
              className="mt-6 text-[length:var(--fs-md)] underline-offset-4 hover:underline transition-colors"
              style={{ color: theme !== 'light' ? '#6b7280' : '#94a3b8' }}
            >
              管理员登录
            </button>
          </div>
        ) : (
        <>

        {normalUserAccessBlocked && (
          <div className="mb-4 px-4 py-2.5 rounded-xl text-[length:var(--fs-md)] text-center"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', color: '#fbbf24' }}>
            临时措施生效中：普通用户访问已关闭，此处仅限管理员登录
          </div>
        )}

        {/* 输入区域 */}
        <div className="space-y-3 mb-5">
          {/* 账户名 */}
          <div className="relative group">
            <input
              ref={usernameRef}
              type="text"
              placeholder="账户"
              value={username}
              autoComplete="username"
              onChange={e => { setUsername(e.target.value); setErr('') }}
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                if (passwordRequired) document.getElementById('pw-input')?.focus()
                else login()
              }}
              className="login-input w-full h-[52px] pl-12 pr-4 rounded-[14px] text-[length:var(--fs-2xl)] text-white placeholder-gray-600 outline-none transition-all duration-300"
            />
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-600 group-focus-within:text-gray-400 transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
          </div>

          {/* 密码 */}
          {passwordRequired && (
          <div className="relative group">
            <input
              id="pw-input"
              type={showPw ? 'text' : 'password'}
              placeholder="密码"
              value={password}
              autoComplete="current-password"
              onChange={e => { setPassword(e.target.value); setErr('') }}
              onKeyDown={e => e.key === 'Enter' && login()}
              className="login-input w-full h-[52px] pl-12 pr-12 rounded-[14px] text-[length:var(--fs-2xl)] text-white placeholder-gray-600 outline-none transition-all duration-300"
            />
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-600 group-focus-within:text-gray-400 transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
            </div>
            {password && (
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors"
                tabIndex={-1}
              >
                {showPw ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            )}
          </div>
          )}
        </div>

        {/* 错误提示 */}
        <div className={`overflow-hidden transition-all duration-300 ${err ? 'max-h-16 opacity-100 mb-4' : 'max-h-0 opacity-0 mb-0'}`}>
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[length:var(--fs-lg)]"
            style={{
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.1)',
              color: '#f87171',
            }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {err}
          </div>
        </div>

        {/* 登录按钮 — ChatGPT 风格: 主题反色 flat, 无渐变/光晕/translateY 抖动 */}
        <button onClick={login} disabled={loading || !username.trim() || (passwordRequired && !password)}
          className="btn-primary w-full h-[52px] rounded-full text-[length:var(--fs-2xl)] font-medium">
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity=".2" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
              </svg>
              登录中
            </span>
          ) : '登录'}
        </button>

        {/* 底部 */}
        {(branding.systemNameEn || branding.systemNameZh) && (
          <div className="text-center mt-16">
            <p className="text-[length:var(--fs-sm)] tracking-wide" style={{ color: theme !== 'light' ? '#374151' : '#9ca3af' }}>
              {[branding.systemNameEn, branding.systemNameZh].filter(Boolean).join(' · ')}
            </p>
          </div>
        )}
        </>
        )}
      </div>

      {/* ── 输入框样式 ── */}
      <style>{`
        .login-input {
          background: ${theme !== 'light' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)'};
          border: 1px solid ${theme !== 'light' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)'};
          color: ${theme !== 'light' ? '#ffffff' : '#1e293b'};
        }
        .login-input:focus {
          background: ${theme !== 'light' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'};
          border-color: rgba(59,130,246,0.3);
          box-shadow: 0 0 0 3px rgba(59,130,246,0.05);
        }
        .login-input::selection {
          background: rgba(59,130,246,0.3);
        }
        .login-input::placeholder {
          color: ${theme !== 'light' ? '#6b7280' : '#64748b'};
        }
      `}</style>
    </div>
  )
}
