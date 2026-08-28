import { lazy, Suspense, useEffect, useState } from 'react'
import type { AdminPanelTab } from './panels'
import { safeWorkbenchReturnTo } from '../services/workbench-navigation'

const AdminPanel = lazy(() => import('./panels').then(module => ({ default: module.AdminPanel })))

type AdminOverlayRequest = {
  id: number
  tab?: AdminPanelTab
  returnTo: string
}

let nextRequestId = 0
let pendingRequest: AdminOverlayRequest | null = null
let showRequest: ((request: AdminOverlayRequest) => void) | null = null

if (typeof window !== 'undefined') {
  window.openAdminOverlay = (tab?: AdminPanelTab) => {
    const returnTo = safeWorkbenchReturnTo(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    )
    const request = { id: ++nextRequestId, tab, returnTo }
    pendingRequest = request
    showRequest?.(request)
    window.dispatchEvent(new CustomEvent('imac:admin-overlay-opened'))
  }
}

export function AdminOverlayHost() {
  const [request, setRequest] = useState<AdminOverlayRequest | null>(null)

  useEffect(() => {
    showRequest = setRequest
    if (pendingRequest) setRequest(pendingRequest)
    return () => { showRequest = null }
  }, [])

  if (!request) return null

  return (
    <div className="theme-overlay workbench-layer-modal fixed inset-0 flex" style={{ background: 'var(--surface-raised, var(--bg-secondary, #0f141b))' }}>
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>正在打开管理中心...</div>}>
        <AdminPanel
          key={request.id}
          onClose={() => {
            pendingRequest = null
            setRequest(null)
          }}
          initialTab={request.tab}
          returnTo={request.returnTo}
        />
      </Suspense>
    </div>
  )
}
