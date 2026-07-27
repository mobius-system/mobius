import { useEffect, useRef } from 'react'
import { Columns2, Sparkles } from 'lucide-react'
import { setLayoutMode, type LayoutMode } from '../services/layout-mode'

type LayoutModeChoiceModalProps = {
  onChoose?: (mode: LayoutMode) => void
}

export function LayoutModeChoiceModal({ onChoose }: LayoutModeChoiceModalProps) {
  const easyButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    easyButtonRef.current?.focus()
  }, [])

  const choose = (mode: LayoutMode) => {
    setLayoutMode(mode)
    onChoose?.(mode)
  }

  return (
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
      data-testid="layout-mode-choice"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="layout-mode-choice-title"
        aria-describedby="layout-mode-choice-description"
        className="w-full max-w-[620px] rounded-2xl border p-5 shadow-2xl sm:p-6"
        style={{ background: 'var(--menu-bg)', borderColor: 'var(--border-color-strong)', color: 'var(--text-primary)' }}
      >
        <div className="mb-5 text-center">
          <span className="mb-3 inline-grid h-11 w-11 place-items-center rounded-xl" style={{ background: 'color-mix(in srgb, var(--accent-primary) 16%, transparent)', color: 'var(--accent-primary)' }}>
            <Sparkles className="h-5 w-5" />
          </span>
          <h1 id="layout-mode-choice-title" className="text-lg font-semibold">选择你的使用模式</h1>
          <p id="layout-mode-choice-description" className="mt-1.5 text-[13px] leading-5" style={{ color: 'var(--text-muted)' }}>
            此选择会保存在当前浏览器中，之后也可以在主题菜单里随时切换。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            ref={easyButtonRef}
            type="button"
            onClick={() => choose('easy_mode')}
            data-testid="choose-easy-mode"
            className="group rounded-xl border p-4 text-left transition hover:-translate-y-0.5 hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            style={{ borderColor: 'color-mix(in srgb, var(--accent-primary) 45%, var(--border-color))' }}
          >
            <span className="mb-3 grid h-9 w-9 place-items-center rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)' }}>
              <Sparkles className="h-4.5 w-4.5" />
            </span>
            <strong className="block text-[14px]">简易模式</strong>
            <span className="mt-1 block text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
              聚焦近期会话、执行过程和最终回复，界面更简洁。
            </span>
          </button>

          <button
            type="button"
            onClick={() => choose('normal_mode')}
            data-testid="choose-normal-mode"
            className="group rounded-xl border p-4 text-left transition hover:-translate-y-0.5 hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            style={{ borderColor: 'var(--border-color-strong)' }}
          >
            <span className="mb-3 grid h-9 w-9 place-items-center rounded-lg" style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
              <Columns2 className="h-4.5 w-4.5" />
            </span>
            <strong className="block text-[14px]">常规模式</strong>
            <span className="mt-1 block text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
              保留项目、任务、原始 JSONL 和完整会话工具。
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
