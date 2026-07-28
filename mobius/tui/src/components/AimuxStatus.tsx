import React from 'react'
import { Box, Text } from 'ink'
import type { AimuxStatus } from '../aimux.js'

const STYLE: Record<AimuxStatus['state'], { icon: string; color: 'green' | 'yellow' | 'red' | 'gray' }> = {
  connected: { icon: '●', color: 'green' },
  starting: { icon: '◐', color: 'yellow' },
  failed: { icon: '●', color: 'red' },
  stopped: { icon: '○', color: 'gray' },
  disabled: { icon: '○', color: 'gray' },
}

export function AimuxStatusLine({ status, compact = false }: { status: AimuxStatus; compact?: boolean }) {
  const style = STYLE[status.state]
  const phase = status.phase && !['idle', 'connected'].includes(status.phase) ? ` · ${phaseLabel(status.phase)}` : ''
  const detail = status.detail || stateLabel(status.state)
  return (
    <Box>
      <Text color={style.color}>{style.icon}</Text>
      <Text dimColor={status.state === 'disabled' || status.state === 'stopped'}>
        {' '}AIMUX{phase} · {compact ? compactDetail(detail) : detail}
      </Text>
    </Box>
  )
}

function stateLabel(state: AimuxStatus['state']): string {
  if (state === 'connected') return '已连接 · 远程 MCP 工具就绪'
  if (state === 'starting') return '连接中…'
  if (state === 'failed') return '连接失败'
  if (state === 'disabled') return '已关闭'
  return '等待登录'
}

function phaseLabel(phase: NonNullable<AimuxStatus['phase']>): string {
  const labels: Record<NonNullable<AimuxStatus['phase']>, string> = {
    idle: '等待', python: '检查 Python', venv: '创建环境', install: '安装',
    connecting: '连接', heartbeat: '心跳', retrying: '重连', connected: '在线',
  }
  return labels[phase]
}

function compactDetail(value: string): string {
  return value.length > 96 ? `${value.slice(0, 95)}…` : value
}
