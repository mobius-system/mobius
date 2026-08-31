import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Check, Feather, UserRound } from 'lucide-react'
import { useStore } from '../store'
import {
  setLayoutMode,
  setSessionDensity,
  useLayoutMode,
  useSessionDensity,
} from '../services/layout-mode'
import { buildEasyModeUrlFromContext } from '../services/easy-route-state'
import { TopNavActionElement } from './top-nav-action'

// =====================================================================
// LayoutModeToggle - 顶栏「极简 / 专家」模式切换按钮 (外观按钮旁).
//
// 行为随上下文分两层 (与主题菜单里的简易模式开关同一套逻辑):
//   - Issue/Research 会话页内且已选中会话: 原地切换呈现密度 (session-density),
//     不导航不卸载 → 草稿/SSE/代码对话 iframe 全保活.
//   - 其他区域 (主页/项目页/极简主页等): 切全局 layout_mode,
//     专业→极简跳 /easy_mode (带 ?session=), 极简→专业由 EasyModePage effect 接管导航.
// =====================================================================
export function LayoutModeToggle() {
  const params = useParams()
  const navigate = useNavigate()
  const layoutMode = useLayoutMode()
  const sessionDensity = useSessionDensity()
  const currentSession = useStore(s => s.currentSession)
  const user = useStore(s => s.user)
  const userParam = params.user || user?.id || ''

  const inSessionContext = !!(params.issue || params.research) && !!currentSession
  const easyActive = inSessionContext ? sessionDensity === 'easy' : layoutMode === 'easy_mode'

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 单击 = 直接切到另一模式 (极简⇄专家一击直达); 下拉只是提供显式两项选择与说明.
  const toggle = () => {
    if (inSessionContext) {
      setSessionDensity(sessionDensity === 'easy' ? 'professional' : 'easy')
      return
    }
    const nextEnabled = layoutMode !== 'easy_mode'
    setLayoutMode(nextEnabled ? 'easy_mode' : 'normal_mode')
    if (nextEnabled) {
      // research 会话跳 research 区带 agent, 其余带 session — 由统一 builder 构造。
      navigate(buildEasyModeUrlFromContext({
        user: userParam,
        sessionId: currentSession?.session_id,
        researchId: (currentSession as any)?.research_id,
        scopeType: (currentSession as any)?.scope_type,
      }))
    }
    // 关闭(极简→专业)时不在此导航: EasyModePage 的 layoutMode 同步 effect 持有完整
    // 上下文, 由它构造目标 Issue/Research 页 URL (见 shell.tsx 同款注释).
  }

  const pick = (mode: 'easy' | 'professional') => {
    setOpen(false)
    if (mode === 'easy') {
      if (inSessionContext) { if (!easyActive) setSessionDensity('easy'); return }
      if (layoutMode !== 'easy_mode') {
        setLayoutMode('easy_mode')
        navigate(buildEasyModeUrlFromContext({
          user: userParam,
          sessionId: currentSession?.session_id,
          researchId: (currentSession as any)?.research_id,
          scopeType: (currentSession as any)?.scope_type,
        }))
      }
      return
    }
    if (inSessionContext) { if (easyActive) setSessionDensity('professional'); return }
    if (layoutMode === 'easy_mode') setLayoutMode('normal_mode')
  }

  return (
    <div className="relative shrink-0" ref={rootRef} data-tour="top-layout-mode-toggle">
      <TopNavActionElement
        type="button"
        onClick={(event: any) => {
          event.stopPropagation()
          toggle()
        }}
        onContextMenu={(event: any) => {
          // 右键(长按)打开显式选择下拉, 平时单击直达 — 极少用但需要时不抓瞎.
          event.preventDefault()
          event.stopPropagation()
          setOpen(v => !v)
        }}
        title={inSessionContext
          ? `切换极简/专家模式（当前 ${easyActive ? '极简' : '专家'}）· 会话内原地切换`
          : `切换极简/专家模式（当前 ${easyActive ? '极简' : '专家'}）`}
        aria-label={`切换极简/专家模式（当前 ${easyActive ? '极简' : '专家'}）`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="layout-mode-toggle"
        className="mobius-topnav-action"
        style={{
          color: easyActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
          background: easyActive ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : undefined,
        }}
      >
        <Feather className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
        <span className="text-[12px] font-medium whitespace-nowrap">{easyActive ? '极简' : '专家'}</span>
      </TopNavActionElement>
      {open && (
        <div
          role="menu"
          aria-label="模式选择"
          className="absolute right-0 top-9 z-50 w-[240px] rounded-xl p-1.5 shadow-xl"
          style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            界面模式
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={easyActive}
            onClick={() => pick('easy')}
            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
            style={{ background: easyActive ? 'var(--bg-active)' : undefined }}
          >
            <Feather className="mt-0.5 h-4 w-4 shrink-0" style={{ color: easyActive ? 'var(--accent-primary)' : 'var(--text-muted)' }} strokeWidth={2} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                极简模式
                {easyActive && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--accent-primary)' }} />}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>低负担对话界面，专注一件事</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!easyActive}
            onClick={() => pick('professional')}
            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
            style={{ background: !easyActive ? 'var(--bg-active)' : undefined }}
          >
            <UserRound className="mt-0.5 h-4 w-4 shrink-0" style={{ color: !easyActive ? 'var(--accent-primary)' : 'var(--text-muted)' }} strokeWidth={2} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                专家模式
                {!easyActive && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--accent-primary)' }} />}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>完整功能与信息密度</span>
            </span>
          </button>
          <div className="mt-1 border-t px-2 pb-1 pt-1.5 text-[10px] leading-snug" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
            {inSessionContext ? '会话内切换 · 原地生效，不影响当前工作区' : '切换页面布局模式'}
          </div>
        </div>
      )}
    </div>
  )
}
