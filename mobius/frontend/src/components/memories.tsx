import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Activity, CheckCircle2, ChevronDown, Cpu, FolderInput, FolderOpen, Lock, Pencil, Plus, RefreshCw, SendHorizontal, Server, Trash2, Upload } from 'lucide-react'
import { api, HIDDEN_FOLDER_NAME } from '../store'
import { ContextAccessModal } from './context-access'
import { MoveScopeModal } from './modals'
import { CopyFromCatalogModal } from './copy-catalog'
import { HelpHint } from './project-page/help-hint'
import {
  CONTEXT_SETUP_DEMO_TOUR_EVENT,
  patchContextSetupDemoState,
  readContextSetupDemoState,
} from '../services/context-setup-demo'

// =====================================================================
// MemoriesManager — 用户级 / 项目级 Memory 管理
// 存储: protected_data/memories/user=<userId>/{default_project|project=<projectId>}/<slug>.md
// 每条 memory = name + description? + body, 用户可在前端添加/编辑/删除.
// =====================================================================
export function MemoriesManager({ scope, projectId }: { scope: 'user' | 'project'; projectId?: string }) {
  const [memories, setMemories] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; memory?: any; managedKind?: string | null } | null>(null)
  const [moving, setMoving] = useState<any | null>(null)
  const [accessing, setAccessing] = useState<any | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [projectKnowledgeRefreshing, setProjectKnowledgeRefreshing] = useState(false)
  const [projectKnowledgeInfo, setProjectKnowledgeInfo] = useState('')
  const [projectKnowledgeUploading, setProjectKnowledgeUploading] = useState(false)
  const [memoryFileUploading, setMemoryFileUploading] = useState(false)
  const [memoryFileInfo, setMemoryFileInfo] = useState('')
  const projectKnowledgeFileRef = useRef<HTMLInputElement | null>(null)
  const memoryFileRef = useRef<HTMLInputElement | null>(null)

  const baseUrl = scope === 'user' ? '/api/memories' : `/api/projects/${projectId}/memories`
  const refresh = useCallback(() => {
    setLoading(true)
    api(baseUrl).then((arr: any[]) => { setMemories(Array.isArray(arr) ? arr : []); setLoading(false) })
      .catch(() => { setMemories([]); setLoading(false) })
  }, [baseUrl])

  useEffect(() => { refresh() }, [refresh])

  const handleDelete = async (m: any) => {
    const id = m.id
    const managed = m.managed_kind === 'project_knowledge'
    const msg = managed
      ? '这是项目知识沉淀 (由 project_knowledge.md 自动同步).\n确定删除? 会同时删除源文件 project_knowledge.md (自动备份到历史, 可经"恢复历史"回滚), 删除后不再被自动重建.'
      : '确定删除该 memory? (会移除对应 .md 文件)'
    if (!confirm(msg)) return
    try {
      const r: any = await api(`${baseUrl}/${id}`, { method: 'DELETE' })
      if (managed && r?.cleared_source) {
        alert('已删除项目知识沉淀及源文件 project_knowledge.md (已自动备份到历史, 可经"恢复历史"回滚).')
      }
      refresh()
    } catch (e: any) { alert(e?.message || '删除失败') }
  }

  const markContextSetupMemorySynced = (result: any) => {
    const state = readContextSetupDemoState()
    if (!state?.active || state.projectId !== projectId) return
    if (!result?.memory && !result?.synced && !result?.uploaded) return
    patchContextSetupDemoState({ memorySyncedAt: Date.now() })
    window.dispatchEvent(new CustomEvent(CONTEXT_SETUP_DEMO_TOUR_EVENT, { detail: { force: true } }))
  }

  const refreshProjectKnowledge = async () => {
    if (scope !== 'project' || !projectId) return
    setProjectKnowledgeRefreshing(true)
    setProjectKnowledgeInfo('')
    try {
      const r: any = await api(`${baseUrl}/project-knowledge/refresh`, { method: 'POST' })
      if (r?.synced) {
        setProjectKnowledgeInfo(`${r.changed ? '已更新' : '已同步'}: ${r.memory_name || '项目知识'} (${r.body_length || 0} 字符)`)
        markContextSetupMemorySynced(r)
      } else {
        setProjectKnowledgeInfo(r?.reason || '未发现项目知识文件')
      }
      refresh()
    } catch (e: any) {
      setProjectKnowledgeInfo(e?.message || '刷新失败')
    } finally {
      setProjectKnowledgeRefreshing(false)
    }
  }

  const uploadProjectKnowledgeFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (scope !== 'project' || !projectId || !file) return
    setProjectKnowledgeUploading(true)
    setProjectKnowledgeInfo('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const r: any = await api(`${baseUrl}/project-knowledge/upload`, {
        method: 'POST',
        body: formData,
      })
      setProjectKnowledgeInfo(
        `已上传并同步: ${r.memory_name || '项目知识'} (${r.body_length || 0} 字符)。` +
        '也可以用新建、复制或刷新项目知识沉淀来创建 Memory。'
      )
      markContextSetupMemorySynced(r)
      refresh()
    } catch (e: any) {
      setProjectKnowledgeInfo(e?.message || '上传失败')
    } finally {
      setProjectKnowledgeUploading(false)
    }
  }

  const uploadMemoryFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || (scope === 'project' && !projectId)) return
    setMemoryFileUploading(true)
    setMemoryFileInfo('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const r: any = await api(`${baseUrl}/import-file`, {
        method: 'POST',
        body: formData,
      })
      const imported = Array.isArray(r?.memories) ? r.memories : []
      const skipped = Array.isArray(r?.skipped) ? r.skipped : []
      setMemoryFileInfo(
        `已导入 ${imported.length} 条: ${imported.map((m: any) => m.name).join(', ') || '无'}` +
        (skipped.length ? `；跳过 ${skipped.length} 条: ${skipped.map((s: any) => `${s.name} (${s.reason})`).join('; ')}` : '')
      )
      if (scope === 'project') markContextSetupMemorySynced(r)
      refresh()
    } catch (e: any) {
      setMemoryFileInfo(e?.message || '上传失败')
    } finally {
      setMemoryFileUploading(false)
    }
  }

  const title = scope === 'user' ? '用户级 Memory' : '项目级 Memory'
  const desc = scope === 'user'
    ? '写入或上传 .md 长期记忆条目，在你创建的所有任务会话中默认注入。'
    : '写入或上传 .md 长期记忆条目，只对本项目后续新建会话默认注入；已有会话已固定快照，不会自动补入。'
  const managerTour = scope === 'user' ? 'user-memory-manager' : 'project-memory-manager'
  const newTour = scope === 'user' ? 'user-memory-new' : 'project-memory-new'
  const copyTour = scope === 'user' ? 'user-memory-copy' : 'project-memory-copy'
  const visibilityLabel = (value: any, itemScope: string) => {
    if (value === 'inherit') return itemScope === 'project' ? '继承项目' : '仅自己'
    if (value === 'team') return '同组'
    if (value === 'public') return '公开'
    if (value === 'allowlist') return '指定用户'
    return '仅自己'
  }

  return (
    <div data-tour={managerTour} className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <h3 className="text-[13px] font-semibold whitespace-nowrap flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{title}</h3>
          <HelpHint text={desc} />
        </div>
        <div className="flex min-w-0 flex-wrap justify-end gap-1">
          <input
            ref={memoryFileRef}
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            className="hidden"
            onChange={uploadMemoryFile}
          />
          <button
            onClick={() => memoryFileRef.current?.click()}
            disabled={memoryFileUploading || (scope === 'project' && !projectId)}
            data-tour={scope === 'user' ? 'user-memory-upload-file' : 'project-memory-upload-file'}
            className="text-[10.5px] px-1.5 py-1 rounded bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border border-sky-500/20 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title="上传本地 .md 文件并创建 Memory, 上限 50MB">
            <Upload className="w-3 h-3" strokeWidth={1.8} />
            {memoryFileUploading ? '上传中...' : '上传'}
          </button>
          {scope === 'project' && (
            <button onClick={() => setRemoteOpen(true)}
              disabled={!projectId}
              data-tour="project-memory-add-remote"
              className="text-[10.5px] px-1.5 py-1 rounded bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/20 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
              title="从 aimux remote 清单生成项目级 Memory">
              <Server className="w-3 h-3" strokeWidth={1.8} />
              添加远程算力
            </button>
          )}
          <button onClick={() => setCopyOpen(true)}
            data-tour={copyTour}
            className="text-[10.5px] px-1.5 py-1 rounded bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border border-violet-500/20 transition-colors whitespace-nowrap"
            title="浏览其他用户/项目的 memory 并复制到这里">
            复制
          </button>
          <button onClick={() => setEditing({ mode: 'create' })}
            data-tour={newTour}
            title="直接编辑或粘贴文本创建 Memory"
            className="text-[10.5px] px-1.5 py-1 rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 transition-colors whitespace-nowrap">
            写入
          </button>
        </div>
      </div>
      {/* <p className="text-[12px] mb-4" style={{ color: 'var(--text-muted)' }}>{desc}</p> */}
      {memoryFileInfo && (
        <pre className="text-[11px] text-amber-400 mb-3 whitespace-pre-wrap break-all max-h-24 overflow-auto">{memoryFileInfo}</pre>
      )}

      {loading ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : memories.length === 0 ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>暂无 memory, 点击右上角写入或上传</div>
      ) : (
        <div className="space-y-2">
          {memories.map((m: any) => {
            const managed = m.managed_kind === 'project_knowledge'
            return (
            <div key={m.id} className="p-3 bg-[var(--bg-card)] rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-[180px] flex-[1_1_180px]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
                    <span className="min-w-32 max-w-full flex-[1_1_8rem] text-[13px] font-medium leading-5 break-words truncate" style={{ color: 'var(--text-primary)' }}>{m.name}</span>
                    {typeof m.body_length === 'number' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>
                        {m.body_length} 字符
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: '#60a5fa', background: 'rgba(96,165,250,0.08)' }}>
                      {visibilityLabel(m.visibility, m.scope)}
                    </span>
                    {managed && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.10)' }} title="由 project_knowledge.md 自动同步; 编辑会写回源文件, 删除会清掉源文件">自动同步</span>
                    )}
                  </div>
                  {m.description && (
                    <p className="text-[11px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{m.description}</p>
                  )}
                </div>
                <div className="ml-auto flex flex-[0_1_auto] flex-wrap items-center justify-end gap-1">
                  {m.can_manage && (
                    <button onClick={() => setAccessing(m)} title="设置可见性和指定用户"
                      className="h-7 w-7 inline-flex items-center justify-center rounded border transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                      <Lock className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => setMoving(m)} disabled={managed} title={managed ? '项目知识随项目绑定路径自动同步, 不支持移动' : (scope === 'user' ? '移到项目级' : '移到我的 / 其他项目')}
                    className="h-7 w-7 inline-flex items-center justify-center rounded border transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                    <FolderInput className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditing({ mode: 'edit', memory: m, managedKind: m.managed_kind })} title={managed ? '编辑项目知识 (写回 project_knowledge.md)' : '编辑'}
                    className="h-7 w-7 inline-flex items-center justify-center rounded border transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(m)} title="删除"
                    className="h-7 w-7 inline-flex items-center justify-center rounded border hover:bg-red-500/10 hover:text-red-400 transition-colors" style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
            )
          })}
        </div>
      )}

      {scope === 'project' && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* <input
            ref={projectKnowledgeFileRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            className="hidden"
            onChange={uploadProjectKnowledgeFile}
          />
          <button
            onClick={() => projectKnowledgeFileRef.current?.click()}
            disabled={projectKnowledgeUploading || !projectId}
            data-tour="project-memory-upload-knowledge"
            className="text-[11px] px-2.5 py-1 rounded bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border border-sky-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title="上传本地 project_knowledge.md, 并同步为项目级 Memory, 上限 50MB">
            <Upload className="w-3 h-3" strokeWidth={1.8} />
            {projectKnowledgeUploading ? '上传中...' : '上传项目知识'}
          </button> */}
          <button onClick={refreshProjectKnowledge}
            disabled={projectKnowledgeRefreshing || !projectId}
            className="text-[11px] px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={`读取项目绑定路径下的 ${HIDDEN_FOLDER_NAME}/project_knowledge.md, 并同步为项目级 Memory`}>
            {projectKnowledgeRefreshing ? '刷新中...' : '刷新项目知识沉淀'}
          </button>
          {projectKnowledgeInfo && (
            <span className="text-[11px] truncate max-w-full" style={{ color: 'var(--text-muted)' }}>
              {projectKnowledgeInfo}
            </span>
          )}
        </div>
      )}

      {editing && (
        <MemoryEditor
          baseUrl={baseUrl}
          mode={editing.mode}
          initial={editing.memory}
          managedKind={editing.managedKind}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
          onRefresh={refresh}
        />
      )}

      {accessing && (
        <ContextAccessModal
          baseUrl={baseUrl}
          item={accessing}
          kindLabel="Memory"
          onClose={() => setAccessing(null)}
          onSaved={() => { setAccessing(null); refresh() }}
        />
      )}

      {moving && (
        <MoveScopeModal
          title={`移动 Memory: ${moving.name}`}
          currentScopeLabel={scope === 'user' ? '我的 (用户级)' : '项目级'}
          lockToProject={scope === 'user'}
          onClose={() => setMoving(null)}
          onMove={async (target) => {
            const body: any = { scope: target.scope }
            if (target.scope === 'project') body.project_id = target.projectId
            await api(`${baseUrl}/${moving.id}/move`, { method: 'POST', body: JSON.stringify(body) })
            setMoving(null); refresh()
          }}
        />
      )}

      {copyOpen && (
        <CopyFromCatalogModal
          kind="memory"
          catalogUrl="/api/memories/catalog"
          copyUrl={`${baseUrl}/copy`}
          targetLabel={title}
          onClose={() => setCopyOpen(false)}
          onCopied={refresh}
        />
      )}

      {remoteOpen && scope === 'project' && (
        <RemoteComputeMemoryModal
          baseUrl={baseUrl}
          onClose={() => setRemoteOpen(false)}
          onSaved={() => { setRemoteOpen(false); refresh() }}
        />
      )}
    </div>
  )
}

type AimuxRemote = {
  name: string
  type?: string
  user: string
  hostname: string
  port: number
  status: string
  rtt_ms: number | null
  cached?: boolean
}

type AddRemoteForm = {
  name: string
  host: string
  user: string
  port: string
  identity: string
  timeout: string
}

type CollapsibleRemoteStatus = 'auth-required' | 'unreachable'

const AIMUX_REMOTE_CACHE_KEY = 'mobius.aimux.remote-scan-cache.v1'

function normalizeAimuxRemote(value: any): AimuxRemote | null {
  const name = typeof value?.name === 'string' ? value.name.trim() : ''
  if (!name) return null
  return {
    name,
    type: typeof value?.type === 'string' ? value.type : '',
    user: typeof value?.user === 'string' ? value.user : '',
    hostname: typeof value?.hostname === 'string' ? value.hostname : '',
    port: Number.isInteger(Number(value?.port)) ? Number(value.port) : 22,
    status: typeof value?.status === 'string' ? value.status : 'unknown',
    rtt_ms: typeof value?.rtt_ms === 'number' ? value.rtt_ms : null,
    cached: !!value?.cached,
  }
}

function readAimuxRemoteCache(): AimuxRemote[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(AIMUX_REMOTE_CACHE_KEY) || 'null')
    if (!Array.isArray(parsed?.remotes)) return []
    return parsed.remotes
      .map(normalizeAimuxRemote)
      .filter((remote: AimuxRemote | null): remote is AimuxRemote => !!remote)
      .map((remote: AimuxRemote) => ({ ...remote, cached: true }))
  } catch {
    return []
  }
}

function writeAimuxRemoteCache(remotes: AimuxRemote[]) {
  if (typeof localStorage === 'undefined') return
  const stable = remotes
    .filter(remote => remote.name && remote.status !== 'probing')
    .map(({ cached: _cached, ...remote }) => remote)
  try {
    localStorage.setItem(AIMUX_REMOTE_CACHE_KEY, JSON.stringify({ saved_at: Date.now(), remotes: stable }))
  } catch {
    // Cache is an acceleration only; quota/privacy-mode failures must not block the modal.
  }
}

function statusStyle(status: string) {
  if (status === 'connected') return { color: '#22c55e', background: 'rgba(34,197,94,0.10)', borderColor: 'rgba(34,197,94,0.25)' }
  if (status === 'reachable') return { color: '#60a5fa', background: 'rgba(96,165,250,0.10)', borderColor: 'rgba(96,165,250,0.25)' }
  if (status === 'auth-required') return { color: '#f59e0b', background: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.25)' }
  if (status === 'unreachable') return { color: '#f87171', background: 'rgba(248,113,113,0.10)', borderColor: 'rgba(248,113,113,0.25)' }
  return { color: 'var(--text-muted)', background: 'rgba(148,163,184,0.10)', borderColor: 'rgba(148,163,184,0.25)' }
}

function inlineCode(value: any) {
  return String(value ?? '').replace(/`/g, "'")
}

function mdCell(value: any) {
  return String(value ?? '-').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '-'
}

function formatRemoteTest(result: any) {
  const r = result?.result || {}
  if (r?.status) {
    return `${r.status}${typeof r.rtt_ms === 'number' ? ` · ${r.rtt_ms}ms` : ''}`
  }
  if (r?.error?.message) return r.error.message
  return result?.message || result?.stdout || result?.stderr || '测试完成'
}

function formatHardware(result: any) {
  const r = result?.result || result || {}
  if (r?.error?.message) return r.error.message
  const parts = []
  if (typeof r.gpu_count === 'number') {
    parts.push(r.gpu_count > 0 ? `${r.gpu_count} x ${r.gpu_model || 'GPU'}` : 'GPU 0')
  }
  if (typeof r.cpu_count === 'number') parts.push(`CPU ${r.cpu_count}`)
  if (typeof r.mem_total_gb === 'number') parts.push(`Mem ${r.mem_total_gb} GB`)
  return parts.join(', ') || result?.message || result?.stdout || result?.stderr || '硬件探测完成'
}

function buildRemoteComputeMemoryBody(
  remotes: AimuxRemote[],
  hardwareByName: Record<string, string>,
  remotePaths: Record<string, string>,
) {
  const lines = [
    '# Aimux 远程算力清单',
    '',
    `生成时间: ${new Date().toISOString()}`,
    '来源: `aimux remote ls --json` / `~/.ssh/config`',
    '',
    '以下 Host 名可作为 aimux 的 `--remote` 参数使用；远程路径可作为 `--cwd` 参数使用。',
    '',
    '| Host | 远程路径 | User | HostName | Port | 状态 | RTT | 硬件 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of remotes) {
    const remotePath = remotePaths[r.name]?.trim() || '默认登录目录'
    lines.push([
      `\`${inlineCode(r.name)}\``,
      `\`${inlineCode(remotePath)}\``,
      mdCell(r.user),
      mdCell(r.hostname),
      mdCell(r.port || 22),
      mdCell(r.status),
      typeof r.rtt_ms === 'number' ? `${r.rtt_ms}ms` : '-',
      mdCell(hardwareByName[r.name] || '-'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  lines.push(
    '',
    '## 使用方式',
    '',
    '- 新建远程 aimux 会话时使用: `aimux new --remote <Host> --cwd <远程路径> --name <session-name>`',
    '- 若远程路径为“默认登录目录”，可省略 `--cwd`。',
    '- 只有状态为 `reachable` 的 Host 已完成免密 SSH 探测；`auth-required` 表示网络可达但认证未通。',
    '',
    '---',
    'name: aimux',
    'description: Use aimux when you need a long-lived shell session — a REPL, a build/server you want to interact with across multiple commands, or anything running on a remote SSH host. Use bash directly for',
    'one-shot commands. aimux gives you session primitives, file-transfer helpers, and remote-host helpers; this skill explains how to combine them.',
    '---',
    '',
    '# Install',
    '',
    '```bash',
    'pip install aimux # or `uv pip install aimux` if using uv venv',
    '```',
    '',
    '# Usage',
    '',
    '`aimux` is tool that enables tmux-like capability cross ssh.',
    '',
    '```bash',
    '(.venv) /home/.../...$ aimux -h',
    '',
    'Usage: aimux [OPTIONS] COMMAND [ARGS]...',
    '',
    'aimux — AI-agent-friendly tmux wrapper.',
    '',
    '─ Options',
    '--help  -h        Show this message and exit.',
    '',
    '─ Commands',
    'ls                          List all aimux sessions.',
    'new                         Create a new session.',
    'attach                      Attach to a session. ⚠️  Human use only — agents should use send-keys + capture.',
    'send-keys                   Send keys to a session. Behaves exactly like \'tmux send-keys\': supports -F/-H/-K/-l/-M/-R/-X/-N <count>. Pass \'Enter\' as a key to submit a line.',
    'send_files                  Upload multiple local files or directories to an SSH host using sftp.',
    'get_files                   Download multiple remote files or directories from an SSH host using sftp.',
    'capture                     Capture pane output (last N lines).',
    'kill                        Destroy a single session. Does not accept wildcards or batch.',
    'wait-last-command-complete  Block until the pane\'s foreground process is back at a shell. Local sessions only.',
    'remote                      Remote-host management (reads/appends ~/.ssh/config).',
    '```',
    '',
    '# Example',
    '',
    '1. adding and naming a remote host in `aimux`.',
    '',
    'First, usually you will get a ssh address, for example,',
    '',
    '```text',
    'HostName localhost',
    'Port 8824',
    'User root',
    '```',
    '',
    'To begin, you will need to check whether this address is already inside `aimux`\'s storage:',
    '```bash',
    '$ aimux remote ls',
    'HOST              USER  HOSTNAME    PORT  STATUS         RTT',
    'github.com        git   github.com  22    auth-required  2261ms',
    'local-8824        root  localhost   8824  reachable      709ms',
    '```',
    '',
    'If not in storage, you will have to add that server using:',
    '',
    '```bash',
    'aimux remote add --host localhost --port 8824 --user root --name local-8824 --timeout 2s',
    'aimux remote test local-8824 --timeout 2s',
    '```',
    '',
    '2. Creating a session and run command in it.',
    '',
    '```bash',
    'aimux new --remote local-8824 --name testsession',
    'aimux send-keys "local-8824/testsession" -- \'ls -la\' Enter',
    'aimux capture "local-8824/testsession" --lines 200',
    '```',
    '',
    '3. Upload and download files.',
    '',
    '```bash',
    '# aimux send_files REMOTE REMOTE_DIR LOCAL_PATH... [--gitignore]',
    '# aimux get_files REMOTE LOCAL_DIR REMOTE_PATH...',
    'aimux send_files local-8824 /tmp/upload /home/alice/cc-workspace/aimux/2fdacb03/tests',
    'aimux get_files local-8824 /home/alice/cc-workspace/aimux /tmp/upload',
    '```',
    '',
    'Use `--gitignore` on upload when ignored files should be skipped:',
    '',
    '```bash',
    'aimux send_files local-8824 /tmp/upload /home/alice/cc-workspace/aimux/2fdacb03/tests --gitignore',
    '```',
    '',
    '4. Clean up.',
    '',
    '```bash',
    'aimux kill "local-8824/testsession"',
    '```',
  )
  return lines.join('\n')
}

// mode='memory' (默认): 勾选 remote → 写入项目 Memory "Aimux 远程算力清单" (旧同名自动移除).
// mode='announce': 同样的勾选/探测/路径 UI, 但确认时不写 Memory, 而是把生成的声明文本
//   经 onAnnounce 作为一条消息发给当前会话的 agent (用于"声明可合作计算机").
export function RemoteComputeMemoryModal({ baseUrl, onClose, onSaved, mode = 'memory', onAnnounce }: {
  baseUrl: string
  onClose: () => void
  onSaved?: () => void
  mode?: 'memory' | 'announce'
  onAnnounce?: (body: string) => void
}) {
  // The session action opens a three-tab menu; the project Memory page keeps
  // the legacy single-purpose "add remote" view by using mode="memory".
  const hasTabs = mode === 'announce'
  const [activeTab, setActiveTab] = useState<'announce' | 'memory' | 'update'>(mode === 'announce' ? 'announce' : 'memory')
  const isAnnounce = activeTab === 'announce'
  const isUpdate = activeTab === 'update'
  const [remotes, setRemotes] = useState<AimuxRemote[]>(readAimuxRemoteCache)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [announceRequirement, setAnnounceRequirement] = useState('')
  const [projectRemoteUpdateText, setProjectRemoteUpdateText] = useState('')
  const [collapsedRemoteStatuses, setCollapsedRemoteStatuses] = useState<Set<CollapsibleRemoteStatus>>(
    () => new Set<CollapsibleRemoteStatus>(['auth-required', 'unreachable']),
  )
  const [busyName, setBusyName] = useState<string | null>(null)
  const [testInfo, setTestInfo] = useState<Record<string, string>>({})
  const [hardwareInfo, setHardwareInfo] = useState<Record<string, string>>({})
  const [remotePaths, setRemotePaths] = useState<Record<string, string>>({})
  const [pathPicker, setPathPicker] = useState<{ remote: AimuxRemote; path: string } | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const loadRequestRef = useRef(0)
  const [addForm, setAddForm] = useState<AddRemoteForm>({
    name: '',
    host: '',
    user: '',
    port: '22',
    identity: '',
    timeout: '5s',
  })

  const applyCompletedRows = useCallback((rows: AimuxRemote[]) => {
    writeAimuxRemoteCache(rows)
    setRemotes(rows)
    setSelected(prev => new Set(Array.from(prev).filter(name => rows.some(r => r.name === name))))
    setRemotePaths(prev => Object.fromEntries(Object.entries(prev).filter(([name]) => rows.some(r => r.name === name))))
  }, [])

  const loadRemotes = useCallback(() => {
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    const requestId = ++loadRequestRef.current
    const seen = new Set<string>()
    let receivedRemote = false
    let completed = false
    setLoading(true); setErr('')

    const legacyFallback = async () => {
      const data: any = await api('/api/aimux/remotes', { signal: controller.signal })
      const rows = (Array.isArray(data?.remotes) ? data.remotes : [])
        .map(normalizeAimuxRemote)
        .filter((remote: AimuxRemote | null): remote is AimuxRemote => !!remote)
        .map((remote: AimuxRemote) => ({ ...remote, cached: false }))
      if (requestId !== loadRequestRef.current) return
      applyCompletedRows(rows)
    }

    const run = async () => {
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
          if (requestId !== loadRequestRef.current) return
          if (event?.event === 'error') throw new Error(event.error || '扫描 aimux remote 失败')
          if (event?.event === 'done') {
            completed = true
            setRemotes(prev => {
              const rows = prev.filter(remote => seen.has(remote.name)).map(remote => ({ ...remote, cached: false }))
              writeAimuxRemoteCache(rows)
              return rows
            })
            return
          }
          if (event?.event !== 'remote') return
          const incoming = normalizeAimuxRemote(event.remote)
          if (!incoming) return
          receivedRemote = true
          seen.add(incoming.name)
          setRemotes(prev => {
            const index = prev.findIndex(remote => remote.name === incoming.name)
            const existing = index >= 0 ? prev[index] : null
            const keepRememberedStatus = event.phase === 'discovered' && existing?.cached
            const nextRemote: AimuxRemote = keepRememberedStatus
              ? { ...incoming, status: existing.status, rtt_ms: existing.rtt_ms, cached: true }
              : { ...incoming, cached: false }
            if (index < 0) return [...prev, nextRemote]
            const next = [...prev]
            next[index] = nextRemote
            return next
          })
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
        if (!completed) {
          setRemotes(prev => {
            const rows = prev.filter(remote => seen.has(remote.name)).map(remote => ({ ...remote, cached: false }))
            writeAimuxRemoteCache(rows)
            return rows
          })
        }
      } catch (error: any) {
        if (error?.name === 'AbortError' || requestId !== loadRequestRef.current) return
        if (!receivedRemote) {
          try { await legacyFallback(); return }
          catch (fallbackError: any) {
            if (fallbackError?.name === 'AbortError') return
            throw fallbackError
          }
        }
        throw error
      }
    }

    run()
      .catch((error: any) => {
        if (requestId === loadRequestRef.current && error?.name !== 'AbortError') {
          setErr(error?.message || '读取 aimux remote 清单失败')
        }
      })
      .finally(() => {
        if (requestId === loadRequestRef.current) setLoading(false)
      })
  }, [applyCompletedRows])

  useEffect(() => {
    if (isUpdate) {
      loadAbortRef.current?.abort()
      setLoading(false)
      return () => undefined
    }
    loadRemotes()
    return () => loadAbortRef.current?.abort()
  }, [isUpdate, loadRemotes])

  const selectedRemotes = useMemo(
    () => remotes.filter(r => selected.has(r.name)),
    [remotes, selected],
  )
  const allSelected = remotes.length > 0 && remotes.every(r => selected.has(r.name))
  const directlyVisibleRemotes = useMemo(
    () => remotes.filter(r => r.status !== 'auth-required' && r.status !== 'unreachable'),
    [remotes],
  )
  const collapsedRemoteGroups = useMemo(() => [
    { status: 'auth-required' as const, label: '需要认证的机器', remotes: remotes.filter(r => r.status === 'auth-required') },
    { status: 'unreachable' as const, label: '不可达的机器', remotes: remotes.filter(r => r.status === 'unreachable') },
  ].filter(group => group.remotes.length > 0), [remotes])
  const bodyPreview = useMemo(
    () => buildRemoteComputeMemoryBody(selectedRemotes, hardwareInfo, remotePaths),
    [selectedRemotes, hardwareInfo, remotePaths],
  )

  const toggleRemote = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    setRemotePaths(prev => name in prev ? prev : { ...prev, [name]: '' })
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(remotes.map(r => r.name)))
    setRemotePaths(prev => {
      const next = { ...prev }
      for (const r of remotes) if (!(r.name in next)) next[r.name] = ''
      return next
    })
  }

  const updateRemotePath = (name: string, path: string) => {
    setRemotePaths(prev => ({ ...prev, [name]: path }))
  }

  const toggleRemoteStatusGroup = (status: CollapsibleRemoteStatus) => {
    setCollapsedRemoteStatuses(prev => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  // 声明模式中可把 remote Host ID 直接附到用户的具体要求末尾，避免手动抄写。
  const appendRemoteIdToRequirement = (name: string) => {
    setAnnounceRequirement(prev => {
      const separator = !prev || /\s$/.test(prev) ? '' : '\n'
      return `${prev}${separator}${name}`
    })
  }

  const testRemote = async (name: string) => {
    setBusyName(`test:${name}`); setErr(''); setInfo('')
    try {
      const result: any = await api('/api/aimux/remotes/test', {
        method: 'POST',
        body: JSON.stringify({ name, timeout: '5s' }),
      })
      setTestInfo(prev => ({ ...prev, [name]: formatRemoteTest(result) }))
    } catch (e: any) {
      setTestInfo(prev => ({ ...prev, [name]: e?.message || '测试失败' }))
    } finally {
      setBusyName(null)
    }
  }

  const probeHardware = async (name: string) => {
    setBusyName(`hardware:${name}`); setErr(''); setInfo('')
    try {
      const result: any = await api('/api/aimux/remotes/hardware', {
        method: 'POST',
        body: JSON.stringify({ name, timeout: '10s' }),
      })
      setHardwareInfo(prev => ({ ...prev, [name]: formatHardware(result) }))
    } catch (e: any) {
      setHardwareInfo(prev => ({ ...prev, [name]: e?.message || '硬件探测失败' }))
    } finally {
      setBusyName(null)
    }
  }

  const updateAddForm = (patch: Partial<AddRemoteForm>) => {
    setAddForm(prev => ({ ...prev, ...patch }))
    setErr(''); setInfo('')
  }

  const addRemote = async () => {
    if (!addForm.host.trim()) { setErr('host 不能为空'); return }
    if (!addForm.user.trim()) { setErr('user 不能为空'); return }
    setBusyName('add'); setErr(''); setInfo('')
    try {
      const result: any = await api('/api/aimux/remotes', {
        method: 'POST',
        body: JSON.stringify({
          host: addForm.host.trim(),
          user: addForm.user.trim(),
          port: addForm.port.trim() || '22',
          name: addForm.name.trim(),
          identity: addForm.identity.trim(),
          timeout: addForm.timeout.trim() || '5s',
        }),
      })
      const addedName = result?.name || addForm.name.trim() || addForm.host.trim()
      setInfo(`已添加 ${addedName}`)
      setSelected(prev => new Set(prev).add(addedName))
      setRemotePaths(prev => ({ ...prev, [addedName]: prev[addedName] || '' }))
      setAddForm({ name: '', host: '', user: '', port: '22', identity: '', timeout: '5s' })
      loadRemotes()
    } catch (e: any) {
      setErr(e?.message || '添加失败')
    } finally {
      setBusyName(null)
    }
  }

  const saveRemoteInventory = async () => {
    if (selectedRemotes.length === 0) { setErr('请至少勾选一台 remote'); return }
    setSaving(true); setErr(''); setInfo('')
    try {
      await api(`${baseUrl}/aimux-remote-inventory`, {
        method: 'POST',
        body: JSON.stringify({
          selected_names: selectedRemotes.map(remote => remote.name),
          remote_paths: remotePaths,
          hardware_by_name: hardwareInfo,
          markdown: bodyPreview,
        }),
      })
      onSaved?.()
    } catch (e: any) {
      setErr(e?.message || '保存远程算力清单失败')
    } finally {
      setSaving(false)
    }
  }

  // announce 模式: 不写 Memory, 把声明文本经 onAnnounce 发给当前会话 agent.
  const sendAnnounce = () => {
    if (selectedRemotes.length === 0) { setErr('请至少勾选一台 remote'); return }
    setErr('')
    const header = '【用户声明：以下计算机可与当前会话的 agent 合作。当任务需要远程算力或需要与这些机器交互时，agent 可通过 aimux 连接并使用它们（参考下方 aimux 使用说明）。】\n\n'
    const requirement = announceRequirement.trim()
    const requirementSection = requirement ? `【具体要求】\n${requirement}\n\n` : ''
    onAnnounce?.(`${header}${requirementSection}${bodyPreview}`)
    onClose()
  }

  const renderRemoteRow = (r: AimuxRemote) => (
    <div key={r.name} data-tour="remote-compute-row" className="p-3 rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
      style={{ borderColor: selected.has(r.name) ? 'rgba(34,211,238,0.35)' : 'var(--input-border)', background: selected.has(r.name) ? 'rgba(34,211,238,0.06)' : 'var(--bg-card)' }}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected.has(r.name)}
          onChange={() => toggleRemote(r.name)}
          className="mt-1 w-4 h-4 accent-cyan-500 cursor-pointer" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium font-mono" style={{ color: 'var(--text-primary)' }}>{r.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap" style={statusStyle(r.status)}>
              {r.status || 'unknown'}{r.cached ? ' [记忆]' : ''}
            </span>
            {typeof r.rtt_ms === 'number' && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{r.rtt_ms}ms</span>
            )}
            {isAnnounce && (
              <button type="button" onClick={() => appendRemoteIdToRequirement(r.name)} disabled={saving}
                data-tour="remote-compute-append-id"
                title={`将机器 ID ${r.name} 追加到具体要求末尾`}
                aria-label={`将机器 ID ${r.name} 追加到具体要求末尾`}
                className="h-6 px-1.5 text-[10px] rounded border transition-colors hover:bg-cyan-500/10 hover:text-cyan-400 disabled:opacity-40"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                添加 ID
              </button>
            )}
          </div>
          <div className="text-[11px] mt-1 truncate font-mono" style={{ color: 'var(--text-secondary)' }}>
            {r.user || '-'}@{r.hostname || r.name}:{r.port || 22}
          </div>
          {(testInfo[r.name] || hardwareInfo[r.name]) && (
            <div className="text-[11px] mt-2 space-y-1" style={{ color: 'var(--text-muted)' }}>
              {testInfo[r.name] && <div>测试: {testInfo[r.name]}</div>}
              {hardwareInfo[r.name] && <div>硬件: {hardwareInfo[r.name]}</div>}
            </div>
          )}
          {selected.has(r.name) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <input value={remotePaths[r.name] || ''}
                onChange={e => updateRemotePath(r.name, e.target.value)}
                data-tour="remote-compute-path-input"
                placeholder="远程路径, 例: /workspace/project"
                disabled={saving}
                className="min-w-[220px] flex-1 h-7 px-2 rounded text-[11px] font-mono focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
              <button type="button"
                onClick={() => setPathPicker({ remote: r, path: remotePaths[r.name] || '~' })}
                disabled={saving || r.cached || r.status !== 'reachable'}
                title={r.cached ? '等待本轮扫描确认后浏览' : (r.status === 'reachable' ? '浏览远端真实路径' : 'remote 状态不是 reachable, 无法浏览')}
                className="h-7 px-2 text-[10.5px] rounded border transition-colors hover:bg-cyan-500/10 hover:text-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                <FolderOpen className="w-3 h-3" strokeWidth={1.8} />
                浏览
              </button>
              {['~', '/workspace', '/root', '/home'].map(p => (
                <button key={p} type="button" onClick={() => updateRemotePath(r.name, p)} disabled={saving}
                  className="h-7 px-2 text-[10.5px] rounded border transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => testRemote(r.name)} disabled={!!busyName || saving}
            data-tour="remote-compute-test"
            title="aimux remote test"
            className="h-7 px-2 text-[11px] rounded border hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 inline-flex items-center gap-1"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
            <Activity className="w-3 h-3" strokeWidth={1.8} />
            {busyName === `test:${r.name}` ? '测试中...' : '测试'}
          </button>
          <button onClick={() => probeHardware(r.name)} disabled={!!busyName || saving}
            data-tour="remote-compute-hardware"
            title="aimux remote hardware"
            className="h-7 px-2 text-[11px] rounded border hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 inline-flex items-center gap-1"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
            <Cpu className="w-3 h-3" strokeWidth={1.8} />
            {busyName === `hardware:${r.name}` ? '探测中...' : '硬件'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div data-tour="remote-compute-modal" className="relative w-[min(980px,calc(100vw-24px))] max-h-[88vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <Server className="w-4 h-4 text-cyan-400 flex-shrink-0" strokeWidth={1.8} />
            <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {isUpdate ? '更新项目远程算力' : (isAnnounce ? '声明可合作计算机' : '添加远程算力')}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded border" style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
              aimux remote
            </span>
          </div>
          <button onClick={onClose} disabled={saving}
            data-tour="remote-compute-close"
            className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40"
            style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {hasTabs && (
          <div className="flex flex-wrap items-center justify-center gap-1 px-5 py-2 border-y" role="tablist" aria-label="远程算力操作" style={{ borderColor: 'var(--border-color)' }}>
            {([
              ['announce', '声明可合作计算机'],
              ['memory', '添加远程算力'],
              ['update', '更新项目远程算力'],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className="h-7 px-2.5 text-[11px] rounded border transition-colors"
                style={activeTab === tab
                  ? { color: 'var(--text-primary)', borderColor: 'rgba(34,211,238,0.45)', background: 'rgba(34,211,238,0.12)' }
                  : { color: 'var(--text-muted)', borderColor: 'transparent' }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {isUpdate ? (
          <div className="flex-1 min-h-0 p-5">
            <label htmlFor="remote-compute-project-update" className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
              项目远程算力更新内容（占位）
            </label>
            <textarea
              id="remote-compute-project-update"
              value={projectRemoteUpdateText}
              onChange={e => setProjectRemoteUpdateText(e.target.value)}
              placeholder="请输入基于当前项目上下文的远程算力更新内容"
              data-tour="remote-compute-project-update"
              data-text-redaction-ignore="true"
              rows={12}
              className="w-full h-full min-h-[220px] resize-y px-3 py-2 rounded-lg text-[12px] leading-relaxed focus:outline-none focus:border-cyan-500/30"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
            />
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] gap-0 flex-1 min-h-0 overflow-hidden">
          <div className="min-w-0 lg:border-r flex flex-col min-h-0" style={{ borderColor: 'var(--border-color)' }}>
            <div className="px-5 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-color)' }}>
              <button onClick={toggleAll} disabled={loading || remotes.length === 0}
                data-tour="remote-compute-select-all"
                className="h-7 px-2.5 text-[11px] rounded border transition-colors disabled:opacity-40"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                {allSelected ? '取消全选' : '全选'}
              </button>
              <button onClick={loadRemotes} disabled={loading || saving}
                className="h-7 px-2.5 text-[11px] rounded border transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40 inline-flex items-center gap-1"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.8} />
                刷新
              </button>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                已选 {selectedRemotes.length}/{remotes.length}
              </span>
              {loading && <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>扫描中...</span>}
            </div>

            <div className="flex-1 overflow-auto p-5 space-y-2">
              {err && <pre className="text-[11px] text-red-400 whitespace-pre-wrap break-all">{err}</pre>}
              {info && <div className="text-[11px] text-emerald-400">{info}</div>}
              {loading && remotes.length === 0 ? (
                <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
              ) : remotes.length === 0 ? (
                <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>暂无 aimux remote</div>
              ) : (
                <>
                  {directlyVisibleRemotes.map(renderRemoteRow)}
                  {collapsedRemoteGroups.map(group => {
                    const collapsed = collapsedRemoteStatuses.has(group.status)
                    return (
                      <div key={group.status} data-tour={`remote-compute-status-group-${group.status}`} className="rounded-lg border overflow-hidden"
                        style={{ borderColor: 'var(--input-border)', background: 'var(--bg-card)' }}>
                        <button type="button" onClick={() => toggleRemoteStatusGroup(group.status)}
                          aria-expanded={!collapsed}
                          className="w-full min-h-9 px-3 flex items-center gap-2 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
                          style={{ color: 'var(--text-muted)' }}>
                          <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`} strokeWidth={1.8} />
                          <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{group.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded border" style={statusStyle(group.status)}>{group.remotes.length}</span>
                          <span className="ml-auto text-[10px]">{collapsed ? '展开' : '收起'}</span>
                        </button>
                        {!collapsed && <div className="p-2 pt-0 space-y-2">{group.remotes.map(renderRemoteRow)}</div>}
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          </div>

          <div className="min-w-0 flex flex-col min-h-0">
            <div className="p-5 border-b space-y-3" style={{ borderColor: 'var(--border-color)' }}>
              <div className="flex items-baseline justify-between gap-2">
                <div data-tour="remote-compute-add-form" className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>新增 remote</div>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>填写 SSH 连接信息，添加后自动测试连通性</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <label htmlFor="remote-compute-add-name" className="block">
                  <span className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>别名</span>
                  <input id="remote-compute-add-name" value={addForm.name} onChange={e => updateAddForm({ name: e.target.value })}
                    placeholder="my-server"
                    disabled={!!busyName || saving}
                    className="w-full h-8 px-2.5 rounded text-[12px] focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </label>
                <label htmlFor="remote-compute-add-port" className="block">
                  <span className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>端口</span>
                  <input id="remote-compute-add-port" value={addForm.port} onChange={e => updateAddForm({ port: e.target.value })}
                    placeholder="22"
                    disabled={!!busyName || saving}
                    className="w-full h-8 px-2.5 rounded text-[12px] focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </label>
                <label htmlFor="remote-compute-add-host" className="block">
                  <span className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>主机 <span className="text-red-400">*</span></span>
                  <input id="remote-compute-add-host" value={addForm.host} onChange={e => updateAddForm({ host: e.target.value })}
                    placeholder="192.168.1.10 或 host.com"
                    disabled={!!busyName || saving}
                    className="w-full h-8 px-2.5 rounded text-[12px] focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </label>
                <label htmlFor="remote-compute-add-user" className="block">
                  <span className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>用户名 <span className="text-red-400">*</span></span>
                  <input id="remote-compute-add-user" value={addForm.user} onChange={e => updateAddForm({ user: e.target.value })}
                    placeholder="root"
                    disabled={!!busyName || saving}
                    className="w-full h-8 px-2.5 rounded text-[12px] focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </label>
                <label htmlFor="remote-compute-add-identity" className="block">
                  <span className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>密钥文件</span>
                  <input id="remote-compute-add-identity" value={addForm.identity} onChange={e => updateAddForm({ identity: e.target.value })}
                    placeholder="~/.ssh/id_rsa"
                    disabled={!!busyName || saving}
                    className="w-full h-8 px-2.5 rounded text-[12px] focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </label>
                <label htmlFor="remote-compute-add-timeout" className="block">
                  <span className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>超时</span>
                  <input id="remote-compute-add-timeout" value={addForm.timeout} onChange={e => updateAddForm({ timeout: e.target.value })}
                    placeholder="5s"
                    disabled={!!busyName || saving}
                    className="w-full h-8 px-2.5 rounded text-[12px] focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </label>
              </div>
              <button onClick={addRemote}
                disabled={!!busyName || saving || !addForm.host.trim() || !addForm.user.trim()}
                className="h-8 px-3 text-[12px] rounded bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/20 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" strokeWidth={1.8} />
                {busyName === 'add' ? '添加中...' : '添加并探测'}
              </button>
              {(!addForm.host.trim() || !addForm.user.trim()) && (
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>填写带 <span className="text-red-400">*</span> 的主机与用户名后即可添加</div>
              )}
            </div>

            <div className="flex-1 min-h-0 p-5 space-y-3 overflow-auto">
              <div className="text-[11px] rounded border px-3 py-2" style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
                {isAnnounce
                  ? <>点击确认后，以下内容将作为一条消息发送给当前会话的智能体。</>
                  : <>将同步唯一的项目 Memory：<span className="font-medium" style={{ color: 'var(--text-primary)' }}>Aimux 远程算力清单</span>；旧同名清单会自动移除。</>
                }
              </div>
              {isAnnounce && (
                <div>
                  <label htmlFor="remote-compute-announce-requirement" className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                    具体要求（可选）
                  </label>
                  <textarea id="remote-compute-announce-requirement" value={announceRequirement}
                    onChange={e => setAnnounceRequirement(e.target.value)}
                    data-tour="remote-compute-announce-requirement"
                    placeholder="例如：请优先在这台机器上执行构建。可点击每台机器旁的“添加 ID”引用它。"
                    disabled={saving}
                    rows={3}
                    className="w-full resize-y min-h-[72px] px-3 py-2 rounded-lg text-[12px] leading-relaxed focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    点击机器旁的“添加 ID”会将该机器的 aimux Host ID 追加到这里。
                  </div>
                </div>
              )}
              <div>
                <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>{isAnnounce ? '发送内容预览' : 'Memory 文本预览'}</label>
                <pre data-tour="remote-compute-memory-preview" className="text-[11px] leading-relaxed whitespace-pre-wrap font-mono p-3 rounded-lg border min-h-[220px] max-h-[320px] overflow-auto"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>
                  {selectedRemotes.length > 0 ? bodyPreview : (isAnnounce ? '勾选 remote 后生成声明内容' : '勾选 remote 后生成 Memory 文本')}
                </pre>
              </div>
            </div>
          </div>
        </div>
        )}

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {isUpdate
              ? '更新项目远程算力功能暂未接入'
              : selectedRemotes.length > 0
              ? (isAnnounce ? `将声明 ${selectedRemotes.length} 台可合作计算机` : `将写入 ${selectedRemotes.length} 台 remote`)
              : '未选择 remote'}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={saving}
              className="h-8 px-3 text-[12px] rounded border disabled:opacity-40"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>取消</button>
            {isUpdate ? null : isAnnounce ? (
              <button onClick={sendAnnounce} disabled={selectedRemotes.length === 0}
                className="h-8 px-4 text-[12px] rounded btn-primary transition-colors disabled:opacity-40 inline-flex items-center gap-1.5">
                <SendHorizontal className="w-3.5 h-3.5" strokeWidth={1.8} />
                发送给当前会话
              </button>
            ) : (
              <button onClick={saveRemoteInventory} disabled={saving || selectedRemotes.length === 0}
                data-tour="remote-compute-create-memory"
                className="h-8 px-4 text-[12px] rounded btn-primary transition-colors disabled:opacity-40 inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={1.8} />
                {saving ? '保存中...' : '保存项目远程清单'}
              </button>
            )}
          </div>
        </div>
      </div>

      {pathPicker && (
        <RemotePathPickerModal
          remote={pathPicker.remote}
          initialPath={pathPicker.path}
          onClose={() => setPathPicker(null)}
          onSelect={(path) => {
            updateRemotePath(pathPicker.remote.name, path)
            setPathPicker(null)
          }}
        />
      )}
    </div>
  )
}

function RemotePathPickerModal({ remote, initialPath, onClose, onSelect }: {
  remote: AimuxRemote
  initialPath: string
  onClose: () => void
  onSelect: (path: string) => void
}) {
  const [pathInput, setPathInput] = useState(initialPath || '~')
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState('')
  const [entries, setEntries] = useState<Array<{ name: string; path: string }>>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const loadPath = useCallback((path: string) => {
    const target = path.trim() || '~'
    setLoading(true); setErr('')
    api('/api/aimux/remotes/browse', {
      method: 'POST',
      body: JSON.stringify({ name: remote.name, path: target, timeout: '8s' }),
    })
      .then((d: any) => {
        const nextPath = d?.path || target
        setCurrentPath(nextPath)
        setPathInput(nextPath)
        setParentPath(d?.parent || '')
        setEntries(Array.isArray(d?.entries) ? d.entries : [])
        setLoading(false)
      })
      .catch(e => {
        setErr(e?.message || '浏览远程路径失败')
        setEntries([])
        setLoading(false)
      })
  }, [remote.name])

  useEffect(() => { loadPath(initialPath || '~') }, [initialPath, loadPath])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[min(720px,calc(100vw-24px))] max-h-[82vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen className="w-4 h-4 text-cyan-400 flex-shrink-0" strokeWidth={1.8} />
            <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>选择远程路径</span>
            <span className="text-[11px] px-2 py-0.5 rounded border font-mono truncate max-w-[260px]"
              style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
              {remote.name}
            </span>
          </div>
          <button onClick={onClose}
            className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors"
            style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b space-y-2" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2">
            <input value={pathInput}
              onChange={e => { setPathInput(e.target.value); setErr('') }}
              onKeyDown={e => { if (e.key === 'Enter' && !loading) loadPath(pathInput) }}
              disabled={loading}
              className="flex-1 min-w-0 h-8 px-2.5 rounded text-[12px] font-mono focus:outline-none focus:border-cyan-500/30 disabled:opacity-40"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
            <button onClick={() => loadPath(pathInput)} disabled={loading}
              className="h-8 px-3 text-[12px] rounded border transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
              {loading ? '打开中...' : '打开'}
            </button>
          </div>
          {currentPath && (
            <div className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
              当前: {currentPath}
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-5 space-y-2">
          {err && <pre className="text-[11px] text-red-400 whitespace-pre-wrap break-all">{err}</pre>}
          {loading ? (
            <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : (
            <>
              {parentPath && parentPath !== currentPath && (
                <button type="button" onClick={() => loadPath(parentPath)}
                  className="w-full h-8 px-2.5 rounded border text-[12px] text-left transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                  ../
                </button>
              )}
              {entries.length === 0 ? (
                <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>当前目录下没有可进入的子目录</div>
              ) : entries.map(entry => (
                <button key={entry.path} type="button" onClick={() => loadPath(entry.path)}
                  className="w-full h-8 px-2.5 rounded border text-[12px] text-left transition-colors hover:bg-cyan-500/10 hover:text-cyan-400 flex items-center gap-2"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                  <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={1.8} />
                  <span className="font-mono truncate">{entry.name}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose}
            className="h-8 px-3 text-[12px] rounded border"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={() => onSelect(currentPath || pathInput.trim() || '~')} disabled={loading || (!currentPath && !pathInput.trim())}
            className="h-8 px-4 text-[12px] rounded btn-primary transition-colors disabled:opacity-40">
            选择当前路径
          </button>
        </div>
      </div>
    </div>
  )
}

// 创建/编辑 memory 的模态. 编辑模式下会先 GET 拿到 body.
// 新建模式下顶部提供「手动编辑 / 从本地路径导入」切换 (与 skills 添加面板同构):
//   - 直接编辑/粘贴: 填标题 + 正文, 等价于原新建表单
//   - 本地路径导入 : 输入服务器绝对路径 (.md 文件 / 含多个 .md 的目录, 递归批量)
//                   复制为快照与源解耦, 同名逐个跳过
function MemoryEditor({ baseUrl, mode, initial, managedKind, onClose, onSaved, onRefresh }: {
  baseUrl: string
  mode: 'create' | 'edit'
  initial?: any
  managedKind?: string | null
  onClose: () => void
  onSaved: () => void
  onRefresh: () => void
}) {
  const isManagedKnowledge = managedKind === 'project_knowledge'
  const [name, setName] = useState(initial?.name || '')
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(mode === 'edit')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  // 新建模式下的子模式: manual=直接编辑/粘贴, local=从本地路径导入
  const [addMode, setAddMode] = useState<'manual' | 'local'>('manual')
  const [localPath, setLocalPath] = useState('')
  const [importInfo, setImportInfo] = useState('')

  useEffect(() => {
    if (mode === 'edit' && initial?.id) {
      api(`${baseUrl}/${initial.id}`)
        .then((d: any) => { setBody(d?.body || ''); setLoading(false) })
        .catch(e => { setErr(e?.message || '加载失败'); setLoading(false) })
    }
  }, [mode, initial?.id, baseUrl])

  const submit = async () => {
    const trimmedName = name.trim()
    if (!isManagedKnowledge && !trimmedName) { setErr('name 不能为空'); return }
    setErr(''); setSaving(true)
    try {
      if (isManagedKnowledge && mode === 'edit') {
        // 项目知识 Memory 是 project_knowledge.md 的自动同步投影:
        // PATCH 单改 memory .md 会被下次列表同步覆盖. 这里把正文写回源文件
        // (POST project-knowledge/upload, 会自动备份+同步), 编辑才真正持久.
        const content = body
        if (!content.trim()) { setErr('项目知识正文不能为空 (如需清空请直接删除该沉淀)'); setSaving(false); return }
        await api(`${baseUrl}/project-knowledge/upload`, { method: 'POST', body: JSON.stringify({ content }) })
      } else {
        const payload = { name: trimmedName, body }
        if (mode === 'create') {
          await api(baseUrl, { method: 'POST', body: JSON.stringify(payload) })
        } else {
          await api(`${baseUrl}/${initial.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        }
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const submitImportLocal = async () => {
    const p = localPath.trim()
    if (!p) { setErr('请输入 memory 的服务器绝对路径'); return }
    setErr(''); setImportInfo(''); setSaving(true)
    try {
      const r: any = await api(`${baseUrl}/import-local`, { method: 'POST', body: JSON.stringify({ path: p }) })
      const imported = Array.isArray(r?.memories) ? r.memories : []
      const skipped = Array.isArray(r?.skipped) ? r.skipped : []
      if (skipped.length > 0) {
        // 部分成功: 留在面板展示结果, 不关闭
        setImportInfo(
          `已导入 ${imported.length} 条: ${imported.map((m: any) => m.name).join(', ') || '无'}\n` +
          `跳过 ${skipped.length} 条: ${skipped.map((s: any) => `${s.name} (${s.reason})`).join('; ')}`
        )
        setLocalPath('')
        onRefresh()
      } else {
        onSaved()
      }
    } catch (e: any) {
      setErr(e?.message || '导入失败')
    } finally {
      setSaving(false)
    }
  }

  const isLocal = mode === 'create' && addMode === 'local'

  // 不绑 onClick={onClose}: 点窗口外不关闭, 防止误点丢失已写内容. 关闭只能走 ✕ / 取消
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div data-tour="memory-editor-modal" className="relative w-[760px] max-h-[85vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {isManagedKnowledge ? '编辑项目知识沉淀' : (mode === 'create' ? '新建 Memory' : '编辑 Memory')}
          </span>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors" style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-3">
          {mode === 'create' && (
            <div className="flex gap-1">
              {([['manual', '直接编辑/粘贴'], ['local', '从本地路径导入']] as const).map(([m, label]) => (
                <button key={m} onClick={() => { setAddMode(m); setErr(''); setImportInfo('') }} disabled={saving}
                  data-tour={m === 'manual' ? 'memory-editor-manual-tab' : 'memory-editor-local-tab'}
                  className="text-[11px] px-2.5 py-1 rounded border transition-colors disabled:opacity-40"
                  style={addMode === m
                    ? { background: 'var(--accent, #3b82f6)', color: '#fff', borderColor: 'transparent' }
                    : { color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {isLocal ? (
            <div>
              <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                服务器本地绝对路径 — 可指向 <code>单个 .md 文件</code> / <code>含多个 .md 的目录 (递归批量)</code>。
                按 frontmatter 的 <code>name</code>/<code>description</code> + 正文导入, 无 frontmatter 时以文件名为标题、整篇为正文。
                单个 Markdown 文件上限 50MB; 复制为快照, 与源解耦; 同名条目逐个跳过。
              </label>
              <input autoFocus value={localPath}
                onChange={e => { setLocalPath(e.target.value); setErr(''); setImportInfo('') }}
                onKeyDown={e => { if (e.key === 'Enter' && !saving) submitImportLocal() }}
                data-tour="memory-editor-local-input"
                placeholder="例: /home/alice/my-memories/notes.md 或 /home/alice/my-memories"
                disabled={saving}
                className="w-full px-2.5 py-1.5 rounded text-[12px] font-mono focus:outline-none focus:border-blue-500/30 disabled:opacity-40"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
            </div>
          ) : (
            <>
              <div>
                <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                  {isManagedKnowledge ? '标题 (随项目名自动派生, 不可改)' : '标题 (必填, 用于列表展示, 单行)'}
                </label>
                <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr('') }}
                  data-tour="memory-editor-name-input"
                  placeholder="例: 使用简体中文回复"
                  disabled={saving || loading || isManagedKnowledge}
                  className="w-full px-2.5 py-1.5 rounded text-[12px] focus:outline-none focus:border-blue-500/30 disabled:opacity-40"
                  style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                {isManagedKnowledge && (
                  <p className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    正文保存后会写回 <code>{`{项目绑定路径}/${HIDDEN_FOLDER_NAME}/project_knowledge.md`}</code> (自动备份历史), 同步刷新本条沉淀.
                  </p>
                )}
              </div>
              <div>
                <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>正文 (Markdown，可直接粘贴文字，保存后写入 .md 文件 body 部分)</label>
                <textarea value={body} onChange={e => { setBody(e.target.value); setErr('') }}
                  data-tour="memory-editor-body-input"
                  placeholder={loading ? '加载中...' : '正文内容, 支持 Markdown ...'}
                  disabled={saving || loading}
                  rows={14}
                  className="w-full px-2.5 py-2 rounded text-[12px] font-mono leading-relaxed focus:outline-none focus:border-blue-500/30 disabled:opacity-40 resize-y"
                  style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
              </div>
            </>
          )}
          {err && <pre className="text-[11px] text-red-400 whitespace-pre-wrap break-all max-h-40 overflow-auto">{err}</pre>}
          {importInfo && <pre className="text-[11px] text-amber-400 whitespace-pre-wrap break-all max-h-48 overflow-auto">{importInfo}</pre>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose} disabled={saving}
            className="h-8 px-3 text-[12px] rounded border disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
            {importInfo ? '关闭' : '取消'}
          </button>
          {isLocal ? (
            <button onClick={submitImportLocal} disabled={saving || !localPath.trim()}
              className="h-8 px-4 text-[12px] rounded btn-primary transition-colors disabled:opacity-40">
              {saving ? '导入中...' : '导入'}
            </button>
          ) : (
            <button onClick={submit} disabled={saving || loading || !name.trim()}
              className="h-8 px-4 text-[12px] rounded btn-primary transition-colors disabled:opacity-40">
              {saving ? '保存中...' : (mode === 'create' ? '创建' : '保存')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
