import modelRegistry from './model-registry';
import agents from '../agents';

function normalizeUseProxy(value: any): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  return null
}

function useProxyForSession(session: any, backend: any = null): number {
  let launch: any
  try {
    launch = modelRegistry.launchOptionsForSession(session)
  } catch {
    // Historical sessions may reference removed models (for example old Sonnet ids).
    // They are not launchable, but admin/status views should stay quiet and direct.
    return 0
  }
  if (launch.forceNoProxy) return 0
  const backendName = backend?.name || launch.backend
  const resolvedBackend = backend || agents.get(backendName)
  const runtimeUseProxy = typeof resolvedBackend.getSessionUseProxy === 'function'
    ? resolvedBackend.getSessionUseProxy(session?.session_id)
    : null
  const normalizedRuntime = normalizeUseProxy(runtimeUseProxy)
  if (normalizedRuntime !== null) return normalizedRuntime ? 1 : 0
  // 管理中心的模型级网络代理设置是唯一信源; 缺省一律直连.
  if (typeof launch.useProxy === 'boolean') return launch.useProxy ? 1 : 0
  return 0
}

function withSessionProxyState(session: any): any {
  if (!session) return session
  let launch: any
  try {
    launch = modelRegistry.launchOptionsForSession(session)
  } catch {
    return {
      ...session,
      use_proxy: 0,
      agent_backend: null,
      model_label: String(session.model || ''),
    }
  }
  return {
    ...session,
    use_proxy: useProxyForSession(session),
    agent_backend: launch.backend,
    model_label: launch.label,
  }
}

function withSessionProxyStates(sessions: any): any[] {
  return Array.isArray(sessions) ? sessions.map(withSessionProxyState) : []
}

export {
  useProxyForSession,
  withSessionProxyState,
  withSessionProxyStates,
}
