import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../store'

type RemoteDeviceNamesValue = {
  getAlias: (deviceId: string) => string
  formatName: (deviceId: string) => string
  setName: (deviceId: string, displayName: string) => Promise<void>
}

const EMPTY_NAMES: Record<string, string> = {}
const NOOP_NAMES: RemoteDeviceNamesValue = {
  getAlias: () => '',
  formatName: deviceId => deviceId,
  setName: async () => {},
}
const RemoteDeviceNamesContext = createContext<RemoteDeviceNamesValue>(NOOP_NAMES)
const BROADCAST_CHANNEL = 'mobius:remote-device-names'

export function remoteDeviceNameKey(deviceId: string): string {
  const match = /^(?:tui|gui)-(.+)-[a-f0-9]{10}$/i.exec(deviceId.trim())
  return match ? `host:${match[1].toLowerCase()}` : `id:${deviceId}`
}

function normalizeNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_NAMES
  return Object.fromEntries(Object.entries(value).filter(([key, name]) => key && typeof name === 'string' && name.trim())) as Record<string, string>
}

export function RemoteDeviceNamesProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [names, setNames] = useState<Record<string, string>>(EMPTY_NAMES)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const requestRef = useRef(0)

  const refreshNames = useCallback(async () => {
    const requestId = ++requestRef.current
    try {
      const result: any = await api('/api/remote_device_name/list')
      if (requestId === requestRef.current) setNames(normalizeNames(result?.names))
    } catch {
      if (requestId === requestRef.current) setNames(EMPTY_NAMES)
    }
  }, [])

  useEffect(() => {
    let active = true
    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(`${BROADCAST_CHANNEL}:${userId}`)
      channelRef.current = channel
      channel.onmessage = event => {
        const message = event.data
        if (active && message?.userId === userId && message?.type === 'names-updated') {
          setNames(normalizeNames(message.names))
        }
      }
    }
    void refreshNames()
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshNames()
    }, 10_000)
    const refreshOnFocus = () => { void refreshNames() }
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnFocus)
    return () => {
      active = false
      window.clearInterval(refreshTimer)
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnFocus)
      requestRef.current += 1
      channel?.close()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [refreshNames, userId])

  const getAlias = useCallback((deviceId: string) => names[remoteDeviceNameKey(deviceId)] || '', [names])
  const formatName = useCallback((deviceId: string) => {
    const alias = names[remoteDeviceNameKey(deviceId)]
    return alias ? `${alias}(${deviceId})` : deviceId
  }, [names])
  const setName = useCallback(async (deviceId: string, displayName: string) => {
    const result: any = await api('/api/remote_device_name/set', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceId, display_name: displayName }),
    })
    const nextNames = normalizeNames(result?.names)
    requestRef.current += 1
    setNames(nextNames)
    channelRef.current?.postMessage({ type: 'names-updated', userId, names: nextNames })
  }, [userId])

  const value = useMemo(() => ({ getAlias, formatName, setName }), [getAlias, formatName, setName])
  return <RemoteDeviceNamesContext.Provider value={value}>{children}</RemoteDeviceNamesContext.Provider>
}

export function useRemoteDeviceNames(): RemoteDeviceNamesValue {
  return useContext(RemoteDeviceNamesContext)
}
