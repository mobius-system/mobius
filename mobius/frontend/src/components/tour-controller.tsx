import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api, useStore } from '../store'
import { readActiveGuidedDemo } from '../services/guided-demo'
import { GuideHelpModal } from './guide-help'
import {
  CONTEXT_SETUP_DEMO_TOUR_EVENT,
  EXTENSION_DEMO_TOUR_EVENT,
  FIRST_ISSUE_TOUR_EVENT,
  GUIDED_DEMO_TOUR_EVENT,
  LOGO_REVIEW_DEMO_TOUR_EVENT,
  PROJECT_IMPORT_DEMO_TOUR_EVENT,
  SELF_EVOLVE_DEMO_TOUR_EVENT,
  runFirstIssueTourForPath,
} from '../services/tour'

// 旧 localStorage 门禁 key (imac:first-login-tour-seen:v1:<userId>) 已废弃 — 首登引导改为
// 按用户维度持久化 (后端 /api/profile/tour-first-login-seen), 换设备/换浏览器不再重复触发.
// 这里只保留多 tab 互斥的 open key (纯 UI, 非门禁).
const FIRST_LOGIN_TOUR_OPEN_KEY_PREFIX = 'imac:first-login-tour-open:v1:'
const FIRST_LOGIN_TOUR_OPEN_TTL_MS = 45_000
const FIRST_LOGIN_TOUR_TAB_ID = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`

function firstLoginTourOpenKey(userId: string) {
  return `${FIRST_LOGIN_TOUR_OPEN_KEY_PREFIX}${userId}`
}

function claimFirstLoginGuide(openKey: string) {
  try {
    const now = Date.now()
    const raw = localStorage.getItem(openKey)
    const current = raw ? JSON.parse(raw) : null
    if (current?.tabId && current.tabId !== FIRST_LOGIN_TOUR_TAB_ID && Number(current.expiresAt) > now) {
      return false
    }
    localStorage.setItem(openKey, JSON.stringify({
      tabId: FIRST_LOGIN_TOUR_TAB_ID,
      expiresAt: now + FIRST_LOGIN_TOUR_OPEN_TTL_MS,
    }))
    const claimed = JSON.parse(localStorage.getItem(openKey) || '{}')
    return claimed?.tabId === FIRST_LOGIN_TOUR_TAB_ID
  } catch {
    return true
  }
}

function releaseFirstLoginGuide(openKey: string) {
  try {
    const raw = localStorage.getItem(openKey)
    const current = raw ? JSON.parse(raw) : null
    if (current?.tabId === FIRST_LOGIN_TOUR_TAB_ID) localStorage.removeItem(openKey)
  } catch {}
}

function ownsFirstLoginGuide(openKey: string) {
  try {
    const raw = localStorage.getItem(openKey)
    const current = raw ? JSON.parse(raw) : null
    return current?.tabId === FIRST_LOGIN_TOUR_TAB_ID && Number(current.expiresAt) > Date.now()
  } catch {
    return true
  }
}

function isUserHomePath(pathname: string, userId: string) {
  return pathname === `/u/${userId}` || pathname === `/u/${userId}/`
}

export function TourController() {
  const location = useLocation()
  const { user } = useStore()
  const [showFirstLoginGuide, setShowFirstLoginGuide] = useState(false)
  const [firstLoginOpenKey, setFirstLoginOpenKey] = useState('')

  useEffect(() => {
    let disposed = false
    let timer: number | null = null

    const scheduleRun = (force = false) => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (disposed) return
        void runFirstIssueTourForPath(location.pathname, { force })
      }, 120)
    }

    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<{ force?: boolean }>).detail
      scheduleRun(detail?.force ?? true)
    }

    scheduleRun(false)
    window.addEventListener(FIRST_ISSUE_TOUR_EVENT, onStart)
    window.addEventListener(GUIDED_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(PROJECT_IMPORT_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(CONTEXT_SETUP_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(SELF_EVOLVE_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(EXTENSION_DEMO_TOUR_EVENT, onStart)
    window.addEventListener(LOGO_REVIEW_DEMO_TOUR_EVENT, onStart)

    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener(FIRST_ISSUE_TOUR_EVENT, onStart)
      window.removeEventListener(GUIDED_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(PROJECT_IMPORT_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(CONTEXT_SETUP_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(SELF_EVOLVE_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(EXTENSION_DEMO_TOUR_EVENT, onStart)
      window.removeEventListener(LOGO_REVIEW_DEMO_TOUR_EVENT, onStart)
    }
  }, [location.pathname, location.search])

  useEffect(() => {
    const userId = user?.id || ''
    if (!userId) return
    if (!isUserHomePath(location.pathname, userId)) return
    if (readActiveGuidedDemo()?.state.active) return

    const openKey = firstLoginTourOpenKey(userId)
    let disposed = false
    let gateTimer: number | null = null
    let showTimer: number | null = null

    // 按用户维度查询是否已看过首登引导 (跨设备生效, 替代旧 localStorage 门禁).
    // seen=true 才抑制; 查询失败退回"未看过"仍尝试弹一次, 避免后端抖动永久卡住新用户.
    const arm = () => {
      if (disposed) return
      gateTimer = window.setTimeout(() => {
        if (disposed) return
        if (!claimFirstLoginGuide(openKey)) return
        showTimer = window.setTimeout(() => {
          if (disposed) return
          if (!ownsFirstLoginGuide(openKey)) return
          setFirstLoginOpenKey(openKey)
          setShowFirstLoginGuide(true)
        }, 80)
      }, 520)
    }

    void api('/api/profile/tour-first-login-seen')
      .then((data: any) => {
        if (disposed) return
        if (data?.seen) return
        arm()
      })
      .catch(() => {
        if (!disposed) arm()
      })

    return () => {
      disposed = true
      if (gateTimer !== null) window.clearTimeout(gateTimer)
      if (showTimer !== null) window.clearTimeout(showTimer)
      releaseFirstLoginGuide(openKey)
    }
  }, [location.pathname, user?.id])

  const closeFirstLoginGuide = (opts?: { rememberNoAuto?: boolean; started?: boolean }) => {
    setShowFirstLoginGuide(false)
    if (firstLoginOpenKey) {
      releaseFirstLoginGuide(firstLoginOpenKey)
      setFirstLoginOpenKey('')
    }
    // 用户已启动 demo/路线 或勾选"以后不弹" → 按用户维度持久标记 seen (跨设备生效).
    // 沿用原有 rememberNoAuto 复选框语义: 未勾且未启动 → 不标记, 下次登录仍可再看.
    if (opts?.started || opts?.rememberNoAuto) {
      void api('/api/profile/tour-first-login-seen', { method: 'POST' }).catch(() => {})
    }
  }

  return showFirstLoginGuide
    ? <GuideHelpModal firstLogin onClose={closeFirstLoginGuide} />
    : null
}
