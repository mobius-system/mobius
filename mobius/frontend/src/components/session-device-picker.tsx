import { useCallback, useEffect, useState } from 'react'
import { api, useStore } from '../store'
import { BRIDGE_DEVICES_SCOPE } from '../services/warm-create-lists'
import { readListCache, writeListCache } from '../services/list-swr-cache'
import { useRemoteDeviceNames } from '../services/remote-device-names'
import { HUB_DEVICE, type SessionDeviceSelection } from '../services/session-device'
import { DropdownSelect, LabelWithRefresh, SectionLabel } from './global-create'

type BridgeDevice = { name: string; status?: string; platform?: string; gui?: { available?: boolean } }

/** Device selection shared by Issue sessions and individual/team Research agents. */
export function SessionDevicePicker({ value, onChange, dark, disabled = false, isDesktop = false, aimuxId = null }: {
  value: SessionDeviceSelection
  onChange: (value: SessionDeviceSelection) => void
  dark: boolean
  disabled?: boolean
  isDesktop?: boolean
  aimuxId?: string | null
}) {
  const { user } = useStore()
  const { formatName } = useRemoteDeviceNames()
  const deviceOverride = value.aimuxId
  const guiAuthorized = value.guiAuthorized
  const DEVICE_AUTO = '__auto__'
  const DEVICE_GUI_PREFIX = '__gui__'
  const [bridgeDevices, setBridgeDevices] = useState<BridgeDevice[]>(() => readListCache<BridgeDevice>(BRIDGE_DEVICES_SCOPE, user?.id)?.list || [])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesLoaded, setDevicesLoaded] = useState(false)
  const devicesCacheOwner = user?.id
  // 与会话头部使用同一设备来源，成功后更新按用户隔离的列表缓存。
  const loadDevices = useCallback(() => {
    setDevicesLoading(true)
    api('/aimux_bridge/api/remotes')
      .then((data: any) => {
        const list: BridgeDevice[] = Array.isArray(data?.remotes) ? data.remotes.filter((d: any) => d?.name) : []
        setBridgeDevices(list)
        writeListCache(BRIDGE_DEVICES_SCOPE, devicesCacheOwner, list)
      })
      // 失败保留缓存旧列表 (清空会让已选设备临时从下拉消失)
      // Keep the cached list on failure; clearing it would hide the already-selected device
      .catch(() => { /* 保留缓存 */ })
      .finally(() => { setDevicesLoading(false); setDevicesLoaded(true) })
  }, [devicesCacheOwner])
  // 挂载时校准缓存；用户也可通过标签旁的刷新按钮重新拉取。
  useEffect(() => { if (!devicesLoaded) loadDevices() }, [devicesLoaded, loadDevices])
  return (
    <div>
      {/* 标签已自带说明, 不再挂 hint —— 半宽列里两者并排会挤爆 */}
      <SectionLabel>
        <LabelWithRefresh label="设备（令智能体在指定设备工作）" loading={devicesLoading} onRefresh={loadDevices} />
      </SectionLabel>
      <DropdownSelect
        value={deviceOverride ? (guiAuthorized ? DEVICE_GUI_PREFIX + deviceOverride : deviceOverride) : DEVICE_AUTO}
        onChange={v => {
          if (v === DEVICE_AUTO) onChange(HUB_DEVICE)
          else if (v.startsWith(DEVICE_GUI_PREFIX)) onChange({ aimuxId: v.slice(DEVICE_GUI_PREFIX.length), guiAuthorized: true })
          else onChange({ aimuxId: v, guiAuthorized: false })
        }}
        dark={dark}
        disabled={disabled}
        placeholder="— 中枢 —"
        emptyText="暂无可协作设备"
        options={[
          // 桌面端默认绑定的是本机标识, web 端没有"本机"概念 → 同一个默认项按平台措辞
          { value: DEVICE_AUTO, label: isDesktop ? '跟随本机' : '中枢', description: aimuxId ? `当前: ${formatName(aimuxId)}` : '只在莫比乌斯中枢上工作' },
          // 继续会话时设备由旧会话继承且不可改; 若它还没出现在 bridge 列表里 (未加载/离线), 补一条占位项,
          // 否则触发器会回落成「中枢」——与实际继承的设备不符.
          // A continued session inherits its device read-only; seed a placeholder while it is absent from the
          // bridge list (not loaded yet / offline) so the trigger does not fall back to the hub label.
          ...(deviceOverride && !bridgeDevices.some(d => d.name === deviceOverride) ? [{
            value: guiAuthorized ? DEVICE_GUI_PREFIX + deviceOverride : deviceOverride,
            label: guiAuthorized ? `${formatName(deviceOverride)} (授权操作图形界面)` : formatName(deviceOverride),
            description: disabled ? '继承自原会话' : '当前选择（设备未在线上列表中）',
          }] : []),
          // 离线设备仍可选 (与头部切换设备一致: 断开时仍可依托中枢继续执行任务), 只标状态不置灰
          // Offline devices stay selectable — they are flagged, not disabled, matching the header switcher
          ...bridgeDevices.flatMap(d => {
            const entry = {
              value: d.name,
              label: formatName(d.name),
              description: [d.platform, d.status === 'connected' ? '在线' : '离线'].filter(Boolean).join(' · '),
              badge: d.status === 'connected' ? undefined : { text: '离线', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
            }
            // 可用 GUI 的设备额外给一个授权变体: 同一设备, 会话注入 remote_gui_* 工具与授权提示词
            // GUI-capable devices get an extra authorized variant: same remote, session gets remote_gui_* tools + prompt
            const guiEntry = d.gui?.available === true ? {
              value: DEVICE_GUI_PREFIX + d.name,
              label: `${formatName(d.name)} (授权操作图形界面)`,
              description: `${d.status === 'connected' ? '在线' : '离线'} · 图形界面 (computer use)`,
              badge: { text: 'GUI', color: '#10b981', bg: 'rgba(16,185,129,0.15)' },
            } : null
            return guiEntry ? [entry, guiEntry] : [entry]
          }),
        ]}
      />
      {devicesLoaded && bridgeDevices.length === 0 && (
        <p className="mt-1 text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>暂无可协作设备</p>
      )}
    </div>
  )
}
