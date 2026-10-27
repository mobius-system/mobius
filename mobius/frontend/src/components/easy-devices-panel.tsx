import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Cpu,
  Loader2,
  MonitorSmartphone,
  Pencil,
  Plus,
  Server,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '../store'
import { useRemoteDeviceNames } from '../services/remote-device-names'

/**
 * 跨设备面板 (issue 2026-10-27, impeccable).
 *
 * 原来这里只画一张只读列表: 名字 + 连接状态, 没有任何可操作的东西. 而设备本身
 * 是有增删改查的 —— SSH 主机写在 ~/.ssh/config 里, 协作设备在 bridge broker 里注册,
 * 两者都能改名. 面板却什么都不给, 于是「设备怎么管理」这个问题在界面里没有答案.
 *
 * 这里把面板做成一个真正的管理面:
 *   - 两类设备分开列 (SSH 主机 / 协作设备), 两者的增删改规则本来就不一样;
 *   - 改名走 per-user 别名 (remote_device_names), 纯展示层, 不影响路由;
 *   - 移除只对「莫比乌斯添加」的 SSH 主机开放 —— 手写进 ~/.ssh/config 的主机
 *     (比如公司跳板机) 不归我们管, 后端会拒绝, 前端也就不给这个按钮;
 *   - 协作设备不能删 (它由客户端自己反连注册, 客户端退出即消失), 只��改名.
 */

type BridgeRemote = {
  name: string
  type?: string
  status?: string
  platform?: string
  default_profile?: string
  profiles?: Array<{ name: string; visible?: boolean; available?: boolean }>
  last_seen?: string
  client_version?: string
  server_version?: string
  version_mismatch?: boolean
}

type SshRemote = {
  name: string
  type?: string
  user?: string
  hostname?: string
  port?: number
  status?: string
  rtt_ms?: number | null
}

type AddForm = {
  name: string
  host: string
  user: string
  port: string
  identity: string
}

const EMPTY_ADD_FORM: AddForm = { name: '', host: '', user: '', port: '22', identity: '' }

// SSH 探测状态 → 面板上的说法. auth-required 不是「离线」: 网络是通的, 只是密钥没配好,
// 把它算成离线会让人以为机器挂了, 白折腾一圈.
// probing 是流式扫描的中间态: 名字已经知道了, 连通性还在探测中.
function sshStatusLabel(status: string): { text: string; tone: 'online' | 'warn' | 'offline' | 'pending' } {
  if (status === 'reachable') return { text: '可达', tone: 'online' }
  if (status === 'auth-required') return { text: '需授权', tone: 'warn' }
  if (status === 'unreachable') return { text: '不可达', tone: 'offline' }
  if (status === 'probing') return { text: '探测中', tone: 'pending' }
  return { text: status || '未知', tone: 'offline' }
}

function timeAgoShort(iso?: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 加载占位: 一行设备卡片的骨架 (图标 + 两行文字).
 * 扫 SSH 主机要真连一次远端 (~1s), 这段时间得有个「正在扫」的样子,
 * 而不是先闪一个「暂无 SSH 主机」再被内容顶掉.
 */
function DeviceSkeleton() {
  return (
    <div className="easy-device-row easy-device-row--skeleton" aria-hidden="true">
      <span className="easy-device-row__icon"><Server className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1">
        <i className="easy-device-skeleton__line easy-device-skeleton__line--title" />
        <i className="easy-device-skeleton__line easy-device-skeleton__line--sub" />
      </span>
    </div>
  )
}

export function EasyDevicesPanel({ isDark }: { isDark: boolean }) {
  const { getAlias, setName } = useRemoteDeviceNames()
  const [bridgeRemotes, setBridgeRemotes] = useState<BridgeRemote[]>([])
  const [sshRemotes, setSshRemotes] = useState<SshRemote[]>([])
  const [bridgeLoading, setBridgeLoading] = useState(true)
  const [sshLoading, setSshLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState<AddForm>(EMPTY_ADD_FORM)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState('')
  const [addInfo, setAddInfo] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busyName, setBusyName] = useState<string | null>(null)
  const [rowError, setRowError] = useState('')
  const loadAbortRef = useRef<AbortController | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const streamRequestRef = useRef(0)

  // bridge 与 ssh 是两套注册表, 代价差一个数量级:
  //   bridge 走 broker 内存表, ~20ms;
  //   ssh 走 aimux remote ls, 每台主机都要真的 SSH 探一次 (探测超时 5s), 整轮 ~900ms.
  // 所以两者分开轮询 —— bridge 10 秒 (连接状态变化快), ssh 60 秒 (探测贵, 少打扰远端).
  const loadBridge = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api('/aimux_bridge/api/remotes', { signal })
      const list = Array.isArray(res?.remotes) ? res.remotes : []
      setBridgeRemotes(list.filter((r: any) => r?.name))
      setError('')
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setError(e?.message || '协作设备列表不可用')
    } finally {
      if (!signal?.aborted) setBridgeLoading(false)
    }
  }, [])

  // SSH 主机用流式端点: 它先发 discovered (名字已知, 状态还是 probing), 再补 result (真状态).
  // 之前用一次性端点, 名字和状态要等整轮探测 (~900ms) 一起到, 期间面板只能显示
  // "暂无 SSH 主机" —— 一台都有的情况下说没有, 是假空态. 流式让名字先落地, 状态后补.
  const loadSsh = useCallback(async (signal?: AbortSignal) => {
    // 每一轮都开一条新流; 上一次的流必须掐掉, 否则两轮扫描会同时打远端,
    // 而且旧轮的迟到事件会覆盖新状态 (requestId 只挡 setState, 挡不住在途的探测).
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller
    if (signal) {
      if (signal.aborted) { controller.abort(); return }
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const requestId = ++streamRequestRef.current
    const seen = new Set<string>()
    const merge = (remote: any) => {
      if (!remote?.name || remote.type === 'bridge') return
      seen.add(remote.name)
      setSshRemotes(prev => {
        const index = prev.findIndex(item => item.name === remote.name)
        const next = { ...remote } as SshRemote
        if (index < 0) return [...prev, next]
        const rows = [...prev]
        rows[index] = next
        return rows
      })
    }
    try {
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('cc-token') : null
      const response = await fetch('/api/aimux/remotes/stream', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const handleEvent = (event: any) => {
        if (requestId !== streamRequestRef.current) return
        if (event?.event === 'error') throw new Error(event.error || '扫描 aimux remote 失败')
        if (event?.event === 'remote') merge(event.remote)
      }
      const drain = () => {
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (line.trim()) handleEvent(JSON.parse(line))
        }
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        drain()
      }
      buffer += decoder.decode()
      if (buffer.trim()) handleEvent(JSON.parse(buffer))
      if (requestId !== streamRequestRef.current) return
      // 流结束才算这一轮扫完: 之前探测过的主机要留下, 没出现在这轮里的删掉.
      setSshRemotes(prev => prev.filter(item => seen.has(item.name)))
      setError('')
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setError(e?.message || 'SSH 主机列表不可用')
    } finally {
      if (!controller.signal.aborted && requestId === streamRequestRef.current) setSshLoading(false)
    }
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    await Promise.all([loadBridge(signal), loadSsh(signal)])
  }, [loadBridge, loadSsh])

  useEffect(() => {
    const controller = new AbortController()
    loadAbortRef.current = controller
    void load(controller.signal)
    return () => {
      controller.abort()
      // 页面切走时把在途的流也掐掉, 别让扫描继续挂在远端上.
      streamAbortRef.current?.abort()
    }
  }, [load])

  // bridge 状态每 10 秒自己刷一次 (与页面其它面板同一节奏), 页面切走时靠 abort 收手.
  useEffect(() => {
    let stopped = false
    let timer: number | null = null
    const tick = async () => {
      if (stopped) return
      const controller = new AbortController()
      const to = window.setTimeout(() => controller.abort(), 10_000)
      try {
        await loadBridge(controller.signal)
      } catch {
        /* 单次失败忽略, 下一轮再试 */
      } finally {
        window.clearTimeout(to)
      }
      if (!stopped) timer = window.setTimeout(tick, 10_000)
    }
    timer = window.setTimeout(tick, 10_000)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [loadBridge])

  // SSH 主机列表 60 秒一次: 每次都要真连一次远端, 太频繁会打扰正在跑任务的机器.
  useEffect(() => {
    let stopped = false
    let timer: number | null = null
    const tick = async () => {
      if (stopped) return
      const controller = new AbortController()
      const to = window.setTimeout(() => controller.abort(), 30_000)
      try {
        await loadSsh(controller.signal)
      } catch {
        /* 单次失败忽略, 下一轮再试 */
      } finally {
        window.clearTimeout(to)
      }
      if (!stopped) timer = window.setTimeout(tick, 60_000)
    }
    timer = window.setTimeout(tick, 60_000)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [loadSsh])

  const startRename = useCallback((deviceId: string) => {
    setRenaming(deviceId)
    setRenameValue(getAlias(deviceId))
    setRowError('')
  }, [getAlias])

  const commitRename = useCallback(async (deviceId: string) => {
    const next = renameValue.trim()
    setRenaming(null)
    if (next === getAlias(deviceId)) return
    setBusyName(`rename:${deviceId}`)
    setRowError('')
    try {
      // 空名 = 删除别名 (后端把空 display_name 视为删除), 所以「清空」也能还原成原始 ID.
      await setName(deviceId, next)
    } catch (e: any) {
      setRowError(e?.message || '重命名失败')
    } finally {
      setBusyName(null)
    }
  }, [renameValue, getAlias, setName])

  const removeSsh = useCallback(async (name: string) => {
    setBusyName(`remove:${name}`)
    setRowError('')
    try {
      await api(`/api/aimux/remotes/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      setRowError(e?.message || '移除失败')
    } finally {
      setBusyName(null)
    }
  }, [load])

  const addSsh = useCallback(async () => {
    if (!addForm.host.trim() || !addForm.user.trim()) {
      setAddError('主机与用户名必填')
      return
    }
    setAddBusy(true)
    setAddError('')
    setAddInfo('')
    try {
      const result: any = await api('/api/aimux/remotes', {
        method: 'POST',
        body: JSON.stringify({
          name: addForm.name.trim(),
          host: addForm.host.trim(),
          user: addForm.user.trim(),
          port: addForm.port.trim() || '22',
          identity: addForm.identity.trim(),
        }),
      })
      const added = result?.name || addForm.name.trim() || addForm.host.trim()
      setAddInfo(`已添加 ${added}`)
      setAddForm(EMPTY_ADD_FORM)
      setShowAdd(false)
      await load()
    } catch (e: any) {
      setAddError(e?.message || '添加失败')
    } finally {
      setAddBusy(false)
    }
  }, [addForm, load])

  const totalCount = bridgeRemotes.length + sshRemotes.length
  const anyLoading = bridgeLoading || sshLoading
  // 只有两边都扫完且确实一台都没有, 才算空 —— 否则会把「还没扫完」说成「没有设备」.
  const empty = totalCount === 0 && !anyLoading && !error

  return (
    <main className="easy-content" data-testid="easy-devices-panel">
      <div className="easy-content-header">
        <MonitorSmartphone className="h-5 w-5" />
        <div>
          <h1>跨设备</h1>
          <p>把智能体放到你自己的机器上干活 · SSH 主机与协作设备</p>
        </div>
        {anyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>{totalCount}</span>}
      </div>

      <div className="easy-devices-toolbar">
        <p className="easy-devices-toolbar__hint">
          设备接入后，智能体可以直接在它上面执行命令、读写文件；会话里用「切换协作设备」指定在哪台机器上工作。
        </p>
        <button
          type="button"
          className="easy-devices-add-btn"
          onClick={() => { setShowAdd(v => !v); setAddError(''); setAddInfo('') }}
          aria-expanded={showAdd}
        >
          {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showAdd ? '取消' : '添加 SSH 主机'}
        </button>
      </div>

      {showAdd && (
        <div className="easy-devices-add" data-testid="easy-devices-add-form">
          <div className="easy-devices-add__grid">
            <label>
              <span>主机 <i>*</i></span>
              <input
                value={addForm.host}
                onChange={e => setAddForm(f => ({ ...f, host: e.target.value }))}
                placeholder="192.168.1.10 或 host.com"
                disabled={addBusy}
                aria-label="主机"
              />
            </label>
            <label>
              <span>用户名 <i>*</i></span>
              <input
                value={addForm.user}
                onChange={e => setAddForm(f => ({ ...f, user: e.target.value }))}
                placeholder="root"
                disabled={addBusy}
                aria-label="用户名"
              />
            </label>
            <label>
              <span>端口</span>
              <input
                value={addForm.port}
                onChange={e => setAddForm(f => ({ ...f, port: e.target.value }))}
                placeholder="22"
                disabled={addBusy}
                aria-label="端口"
              />
            </label>
            <label>
              <span>别名</span>
              <input
                value={addForm.name}
                onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                placeholder="my-server"
                disabled={addBusy}
                aria-label="别名"
              />
            </label>
            <label className="easy-devices-add__wide">
              <span>密钥文件</span>
              <input
                value={addForm.identity}
                onChange={e => setAddForm(f => ({ ...f, identity: e.target.value }))}
                placeholder="~/.ssh/id_rsa"
                disabled={addBusy}
                aria-label="密钥文件"
              />
            </label>
          </div>
          <div className="easy-devices-add__actions">
            <button type="button" className="easy-devices-add__submit" onClick={addSsh} disabled={addBusy}>
              {addBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {addBusy ? '探测中…' : '添加并探测'}
            </button>
            <span className="easy-devices-add__note">添加前会先探测连通性，不通则不会写入 SSH 配置。</span>
          </div>
          {addError && <p className="easy-devices-error">{addError}</p>}
          {addInfo && <p className="easy-devices-ok">{addInfo}</p>}
        </div>
      )}

      {rowError && <p className="easy-devices-error easy-devices-error--page">{rowError}</p>}

      {error ? (
        <div className="easy-content-empty">
          <Cpu className="h-8 w-8" />
          <span>{error}</span>
          <button type="button" className="easy-list-empty__action" onClick={() => void load()}>重试</button>
        </div>
      ) : empty ? (
        <div className="easy-content-empty">
          <MonitorSmartphone className="h-8 w-8" />
          <span>还没有接入任何设备</span>
          <span style={{ fontSize: 'var(--fs-sm)' }}>
            添加 SSH 主机后可在其上执行命令；协作设备需在目标机器上运行 <code>aimux reverse connect</code> 自动注册。
          </span>
          <button type="button" className="easy-list-empty__action" onClick={() => setShowAdd(true)}>+ 添加 SSH 主机</button>
        </div>
      ) : (
        <div className="easy-devices-groups">
          <section className="easy-devices-group">
            <h2>SSH 主机 <span>{sshRemotes.length}</span></h2>
            <p className="easy-devices-group__note">写在 ~/.ssh/config 里的主机，智能体可在其上执行命令与读写文件。</p>
            {sshLoading && sshRemotes.length === 0 ? (
              // 还在扫: 先占位, 别急着说「暂无」—— 扫完可能是有主机的.
              <div className="easy-device-list" aria-busy="true" aria-label="正在扫描 SSH 主机">
                <DeviceSkeleton />
                <DeviceSkeleton />
              </div>
            ) : sshRemotes.length === 0 ? (
              <div className="easy-list-empty">
                <Server className="h-5 w-5" strokeWidth={1.8} />
                <span>暂无 SSH 主机</span>
                <button type="button" className="easy-list-empty__action" onClick={() => setShowAdd(true)}>+ 添加 SSH 主机</button>
              </div>
            ) : (
              <div className="easy-device-list">
                {sshRemotes.map(remote => {
                  const status = sshStatusLabel(String(remote.status || ''))
                  const alias = getAlias(remote.name)
                  // ssh config 里没写 User/HostName 时 (只有 Host 别名) 那两栏是空的,
                  // 直接拼会得到 ":12340 392ms" 这种没有主机的碎片 —— 回落成别名本身.
                  const endpoint = remote.user && remote.hostname
                    ? `${remote.user}@${remote.hostname}`
                    : remote.hostname || remote.name
                  const detail = [
                    remote.port ? `${endpoint}:${remote.port}` : endpoint,
                    typeof remote.rtt_ms === 'number' ? `${remote.rtt_ms}ms` : '',
                  ].filter(Boolean).join(' · ')
                  return (
                    <div key={remote.name} className="easy-device-row">
                      <span className="easy-device-row__icon"><Server className="h-5 w-5" /></span>
                      <span className="min-w-0 flex-1">
                        {renaming === remote.name ? (
                          <input
                            className="easy-device-row__rename"
                            value={renameValue}
                            autoFocus
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => void commitRename(remote.name)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); void commitRename(remote.name) }
                              if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
                            }}
                            aria-label={`重命名 ${remote.name}`}
                          />
                        ) : (
                          <strong title={remote.name}>{alias || remote.name}</strong>
                        )}
                        <small>{detail || remote.name}</small>
                      </span>
                      <span className={`easy-device-row__status is-${status.tone}`}><i />{status.text}</span>
                      <span className="easy-device-row__actions">
                        {renaming !== remote.name && (
                          <button
                            type="button"
                            className="easy-device-row__act"
                            onClick={() => startRename(remote.name)}
                            disabled={busyName === `rename:${remote.name}`}
                            title="重命名（仅本机可见）"
                            aria-label={`重命名 ${remote.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="easy-device-row__act easy-device-row__act--danger"
                          onClick={() => void removeSsh(remote.name)}
                          disabled={busyName === `remove:${remote.name}`}
                          title="移除这台主机"
                          aria-label={`移除 ${remote.name}`}
                        >
                          {busyName === `remove:${remote.name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="easy-devices-group">
            <h2>协作设备 <span>{bridgeRemotes.length}</span></h2>
            <p className="easy-devices-group__note">在目标机器上运行 aimux 客户端反连注册的设备，智能体通过 MCP 工具直接操作它。</p>
            {bridgeLoading && bridgeRemotes.length === 0 ? (
              <div className="easy-device-list" aria-busy="true" aria-label="正在读取协作设备">
                <DeviceSkeleton />
              </div>
            ) : bridgeRemotes.length === 0 ? (
              <div className="easy-list-empty">
                <MonitorSmartphone className="h-5 w-5" strokeWidth={1.8} />
                <span>暂无协作设备</span>
                <span style={{ fontSize: 'var(--fs-xs)' }}>在目标机器上执行 aimux reverse connect 后会自动出现在这里。</span>
              </div>
            ) : (
              <div className="easy-device-list">
                {bridgeRemotes.map(remote => {
                  const alias = getAlias(remote.name)
                  const connected = remote.status === 'connected'
                  const lastSeen = timeAgoShort(remote.last_seen)
                  const detail = [
                    remote.platform,
                    remote.default_profile,
                    connected ? '' : (lastSeen ? `最后在线 ${lastSeen}` : ''),
                  ].filter(Boolean).join(' · ')
                  return (
                    <div key={remote.name} className="easy-device-row">
                      <span className="easy-device-row__icon"><MonitorSmartphone className="h-5 w-5" /></span>
                      <span className="min-w-0 flex-1">
                        {renaming === remote.name ? (
                          <input
                            className="easy-device-row__rename"
                            value={renameValue}
                            autoFocus
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => void commitRename(remote.name)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); void commitRename(remote.name) }
                              if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
                            }}
                            aria-label={`重命名 ${remote.name}`}
                          />
                        ) : (
                          <strong title={remote.name}>{alias || remote.name}</strong>
                        )}
                        <small>{detail || 'AIMUX remote'}</small>
                      </span>
                      {remote.version_mismatch && (
                        <span className="easy-device-row__warn" title={`客户端 ${remote.client_version || '未知'} 与服务端 ${remote.server_version || '未知'} 版本不一致`}>版本不一致</span>
                      )}
                      <span className={`easy-device-row__status ${connected ? 'is-online' : 'is-offline'}`}><i />{connected ? '在线' : '离线'}</span>
                      <span className="easy-device-row__actions">
                        {renaming !== remote.name && (
                          <button
                            type="button"
                            className="easy-device-row__act"
                            onClick={() => startRename(remote.name)}
                            disabled={busyName === `rename:${remote.name}`}
                            title="重命名（仅本机可见）"
                            aria-label={`重命名 ${remote.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {renaming && (
        <span className="sr-only" role="status">
          <Check className="h-3 w-3" />
        </span>
      )}
    </main>
  )
}
