import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

const LOCATION_MESSAGE = 'mobius:native-easy-location'
const HOST_LOCATION_MESSAGE = 'mobius:native-easy-host-location'
const NATIVE_EASY_ENTRY_VERSION = 'workbench-99e3b3e4-v2'

function locationPath(location: ReturnType<typeof useLocation>) {
  return `${location.pathname}${location.search}${location.hash}`
}

export function NativeEasyModeFrame() {
  const location = useLocation()
  const navigate = useNavigate()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const initialSrcRef = useRef<string>()

  if (!initialSrcRef.current) {
    initialSrcRef.current = `/easy-native.html?v=${NATIVE_EASY_ENTRY_VERSION}&route=${encodeURIComponent(locationPath(location))}`
  }

  useEffect(() => {
    const receiveLocation = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return
      if (event.data?.type !== LOCATION_MESSAGE) return
      const rawPath = event.data?.path
      if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//')) return
      let nextPath = ''
      try {
        const url = new URL(rawPath, window.location.origin)
        if (url.origin !== window.location.origin) return
        nextPath = `${url.pathname}${url.search}${url.hash}`
      } catch {
        return
      }
      if (nextPath !== locationPath(location)) navigate(nextPath, { replace: true })
    }
    window.addEventListener('message', receiveLocation)
    return () => window.removeEventListener('message', receiveLocation)
  }, [location, navigate])

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({
      type: HOST_LOCATION_MESSAGE,
      path: locationPath(location),
    }, window.location.origin)
  }, [location])

  return (
    <iframe
      ref={frameRef}
      src={initialSrcRef.current}
      title="简易模式"
      data-testid="native-easy-mode-frame"
      className="block h-screen w-screen border-0"
      style={{ background: 'var(--bg-primary)' }}
      onLoad={() => {
        frameRef.current?.contentWindow?.postMessage({
          type: HOST_LOCATION_MESSAGE,
          path: locationPath(location),
        }, window.location.origin)
      }}
    />
  )
}
