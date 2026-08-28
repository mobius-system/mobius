import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import {
  CONTEXT_SETUP_DEMO_TOUR_EVENT,
  EXTENSION_DEMO_TOUR_EVENT,
  FIRST_ISSUE_TOUR_EVENT,
  GUIDED_DEMO_TOUR_EVENT,
  LOGO_REVIEW_DEMO_TOUR_EVENT,
  PROJECT_IMPORT_DEMO_TOUR_EVENT,
  SELF_EVOLVE_DEMO_TOUR_EVENT,
  runFirstIssueTourForPath,
  startSceneTour,
  type SceneTourKind,
} from '../services/tour'

// 引导现在只响应用户显式发起的“重温/演示”事件。
// 登录、进入任务、Research 或管理中心时均不会自动遮挡当前工作面。
export function TourController() {
  const location = useLocation()

  useEffect(() => {
    let timer: number | null = null
    const scheduleRun = (force = true) => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void runFirstIssueTourForPath(location.pathname, { force })
      }, 120)
    }
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<{ force?: boolean }>).detail
      scheduleRun(detail?.force ?? true)
    }
    const events = [
      FIRST_ISSUE_TOUR_EVENT,
      GUIDED_DEMO_TOUR_EVENT,
      PROJECT_IMPORT_DEMO_TOUR_EVENT,
      CONTEXT_SETUP_DEMO_TOUR_EVENT,
      SELF_EVOLVE_DEMO_TOUR_EVENT,
      EXTENSION_DEMO_TOUR_EVENT,
      LOGO_REVIEW_DEMO_TOUR_EVENT,
    ]
    events.forEach(eventName => window.addEventListener(eventName, onStart))
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      events.forEach(eventName => window.removeEventListener(eventName, onStart))
    }
  }, [location.pathname])

  useEffect(() => {
    const onSceneTourRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ scene?: SceneTourKind; force?: boolean }>).detail
      if (!detail?.scene) return
      if (detail.scene === 'admin-center') window.openAdminOverlay?.()
      window.setTimeout(() => {
        void startSceneTour(detail.scene as SceneTourKind)
      }, detail.scene === 'admin-center' ? 420 : 80)
    }
    window.addEventListener('imac:scene-tour-request', onSceneTourRequest)
    return () => window.removeEventListener('imac:scene-tour-request', onSceneTourRequest)
  }, [])

  return null
}
