// 桌面端「告知本电脑的存在」按钮。
// 仅当 (1) Electron 桌面端 (window.mobiusDesktop.isDesktop) 且 (2) 当前 session 不是
// 由 PC client 创建 (无有效 pc_client_metadata.aimux_id) 时渲染; 这种情况下
// AimuxLinkIndicator 返回 null (当前 agent 不知道这台 PC), 本按钮补位, 让用户一键把
// "本机 aimux 远程对象" 告知当前 session 的 agent。
// 点击 → 经 onSend 向 session 发一条授权连接消息; 绿色冲击特效参考终止按钮;
// localStorage 记录已点击 (per-session) → 按钮变灰但可二次点击。
import { memo, useEffect, useState } from 'react'
import { Laptop } from 'lucide-react'
import { isPcClientSession } from './aimux-link-indicator'

type DesktopBridge = {
  isDesktop?: boolean
  getBootData?: () => Promise<{ aimuxIdentifier?: string }>
  getProjectLocalPath?: (projectId: string) => Promise<string | null>
}

function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined' ? (window as { mobiusDesktop?: any }).mobiusDesktop : undefined
}

// 与系统 skill 注入 (session-context.ts) 一致的相对路径, agent 一定能据此找到。
const SKILL_REF = '.imac/skills/mobius-aimux/SKILL.md'

function buildAnnounceContent(aimuxId: string, localPath: string | null): string {
  const trimmed = typeof localPath === 'string' ? localPath.trim() : ''
  const pathClause = trimmed
    ? `，可操作远程路径 \`${trimmed}\``
    : '，可操作用户的默认登录目录'
  return `【用户希望你知道，用户正在使用 ${aimuxId} 设备访问，你现在被授权使用 aimux 连接到该远程对象${pathClause}。当你的任务需要与用户桌面 PC 交互时，参考 ${SKILL_REF}，建立与用户 PC 的直接连接。】`
}

function storageKey(sessionId: string) {
  return `mobius:announce-pc:${sessionId}`
}

function readClicked(sessionId: string): boolean {
  if (typeof window === 'undefined' || !sessionId) return false
  try { return window.localStorage.getItem(storageKey(sessionId)) === '1' } catch { return false }
}

function writeClicked(sessionId: string) {
  if (typeof window === 'undefined' || !sessionId) return
  try { window.localStorage.setItem(storageKey(sessionId), '1') } catch {}
}

function AnnouncePcButtonInner({
  session,
  sessionId,
  projectId,
  onSend,
}: {
  session: unknown
  sessionId: string
  projectId: string
  onSend: (content: string) => void
}) {
  const md = getDesktopBridge()
  const visible = !!md?.isDesktop && !!sessionId && !isPcClientSession(session)
  const [clicked, setClicked] = useState<boolean>(() => readClicked(sessionId))
  const [firing, setFiring] = useState(false)

  // 切换 session 时按新 sessionId 重读本地记录
  useEffect(() => { setClicked(readClicked(sessionId)) }, [sessionId])

  if (!visible) return null

  const handleClick = async () => {
    if (firing) return
    setFiring(true)
    window.setTimeout(() => setFiring(false), 1800)

    // 收集本机 aimux 标识符 + (可选) 当前项目在本机的路径
    let aimuxId = ''
    let localPath: string | null = null
    try {
      const boot = await md?.getBootData?.()
      aimuxId = boot?.aimuxIdentifier || ''
    } catch {}
    try {
      if (projectId) localPath = (await md?.getProjectLocalPath?.(projectId)) ?? null
    } catch {}
    if (!aimuxId) {
      // 几乎不可能 (登录后 identifier 恒有); 真发生就不发空消息、也不置灰, 留待重试
      console.warn('[AnnouncePcButton] 无法获取本机 aimux 标识符, 已取消发送')
      return
    }

    writeClicked(sessionId)
    setClicked(true)
    onSend(buildAnnounceContent(aimuxId, localPath))
  }

  const base =
    'announce-pc-button px-2 py-0.5 text-[11px] rounded-full transition-all hidden md:inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer select-none'
  const tone = clicked
    ? 'border border-gray-500/25 text-gray-400 hover:bg-gray-500/10'
    : 'border border-green-500/30 text-green-300 hover:bg-green-500/15 hover:text-green-100'
  const active = firing ? 'announce-pc-button--active' : ''
  const clickedCls = clicked ? 'announce-pc-button--clicked' : ''

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-live="polite"
      title={clicked ? '再次告知当前 agent 本电脑可作为 aimux 远程对象连接（已告知过）' : '告知当前 agent：本电脑可作为 aimux 远程对象连接'}
      className={`${base} ${tone} ${active} ${clickedCls}`}
    >
      {firing && (
        <>
          <span className="announce-pc-button__shock" />
          <span className="announce-pc-button__ring announce-pc-button__ring--one" />
          <span className="announce-pc-button__ring announce-pc-button__ring--two" />
        </>
      )}
      <Laptop className="announce-pc-button__icon w-3 h-3" strokeWidth={1.75} />
      <span className="relative z-10 whitespace-nowrap">{clicked ? '已宣告本机存在' : '告知本电脑的存在'}</span>
    </button>
  )
}

export const AnnouncePcButton = memo(AnnouncePcButtonInner)
