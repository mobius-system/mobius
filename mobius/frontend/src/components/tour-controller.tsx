import { useEffect, useRef } from 'react'
import { api, useStore } from '../store'
import { startSceneTour } from '../services/tour'

// 管理中心首触引导: 打开管理中心 overlay 时 (shell.tsx 打开时派发 imac:admin-overlay-opened),
// 按 用户×场景 维度查 seen 门禁, 未看过则自动启动无状态引导.
// 引导一旦成功启动, 立刻按 用户×场景 标记 seen (跨设备生效) —— 不等销毁:
// 旧实现等 tour 销毁才 POST seen, 用户中途切走/页面卸载时 onDone 易漏触发, seen 未落库 → 下次又弹.
// 项目内引导只剩管理中心这一条, 故本组件只处理该场景; 手动重温由管理中心标题栏的引导按钮直接启动.
export function TourController() {
  const { user } = useStore()
  const armRef = useRef(false)

  useEffect(() => {
    const userId = user?.id || ''
    if (!userId) return
    let cancelled = false
    let timer: number | null = null

    const arm = () => {
      // 防同一会话内重复触发 (seen 查询与 360ms 延时期间用户可能反复开关管理中心).
      if (armRef.current) return
      armRef.current = true
      void api('/api/profile/scene-seen/admin-center')
        .then((data: any) => {
          if (cancelled || data?.seen) return
          // 延迟让管理中心 DOM 渲染稳定再启动引导.
          timer = window.setTimeout(() => {
            if (cancelled) return
            void startSceneTour('admin-center').then((started: boolean) => {
              if (started && !cancelled) {
                void api('/api/profile/scene-seen/admin-center', { method: 'POST' }).catch(() => {})
              }
            })
          }, 360)
        })
        .catch(() => {})
    }

    window.addEventListener('imac:admin-overlay-opened', arm)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('imac:admin-overlay-opened', arm)
    }
  }, [user?.id])

  return null
}
