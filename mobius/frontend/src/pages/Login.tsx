import { useState, useEffect, useRef } from 'react'
import { useStore, api } from '../store'
import { MobiusLogo } from '../components/mobius-logo'
import { THEME_NAMES } from '../theme'

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
  const { setAuth, theme, backgroundFlowEnabled, branding } = useStore()
  const usernameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMounted(true)
    setTimeout(() => usernameRef.current?.focus(), 400)
    api('/api/auth/config')
      .then((r: { password_required?: boolean }) => setPasswordRequired(!!r.password_required))
      .catch(() => setPasswordRequired(false))
  }, [])

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
            <h1 className="text-[28px] font-semibold tracking-tight mb-2"
              style={{ color: theme !== 'light' ? '#ffffff' : '#1e293b' }}>
              {branding.systemNameEn}
            </h1>
          )}
          {branding.systemNameZh && (
            <p className="text-[13px]" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b' }}>
              {branding.systemNameZh}
            </p>
          )}
        </div>

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
              className="login-input w-full h-[52px] pl-12 pr-4 rounded-[14px] text-[15px] text-white placeholder-gray-600 outline-none transition-all duration-300"
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
              className="login-input w-full h-[52px] pl-12 pr-12 rounded-[14px] text-[15px] text-white placeholder-gray-600 outline-none transition-all duration-300"
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
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px]"
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
          className="btn-primary w-full h-[52px] rounded-full text-[15px] font-medium">
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
            <p className="text-[11px] tracking-wide" style={{ color: theme !== 'light' ? '#374151' : '#9ca3af' }}>
              {[branding.systemNameEn, branding.systemNameZh].filter(Boolean).join(' · ')}
            </p>
          </div>
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
