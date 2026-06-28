import { useState, useEffect, useCallback, useRef } from 'react'
import { Upload } from 'lucide-react'
import { api } from '../store'
import { ContextAccessModal } from './context-access'
import { MoveScopeModal } from './modals'
import { CopyFromCatalogModal } from './copy-catalog'
import {
  CONTEXT_SETUP_DEMO_TOUR_EVENT,
  patchContextSetupDemoState,
  readContextSetupDemoState,
} from '../services/context-setup-demo'

// =====================================================================
// SkillsManager — 用户级 / 项目级 Skill 管理
// 存储: protected_data/skills/user=<userId>/{default_project|project=<projectId>}/<skill-dir>/SKILL.md
// 添加: 输入 skill 标识符, 后端在对应目录执行 `npx --yes skills add <name>`
// =====================================================================
export function SkillsManager({ scope, projectId }: { scope: 'user' | 'project'; projectId?: string }) {
  const [skills, setSkills] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [addMode, setAddMode] = useState<'manual' | 'github' | 'local'>('manual')
  const [skillName, setSkillName] = useState('')
  const [manualName, setManualName] = useState('')
  const [manualDescription, setManualDescription] = useState('')
  const [manualBody, setManualBody] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [importInfo, setImportInfo] = useState('')
  const [err, setErr] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [viewing, setViewing] = useState<any | null>(null)
  const [moving, setMoving] = useState<any | null>(null)
  const [accessing, setAccessing] = useState<any | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [fileImporting, setFileImporting] = useState(false)
  const [fileImportInfo, setFileImportInfo] = useState('')
  const skillFileInputRef = useRef<HTMLInputElement | null>(null)

  const baseUrl = scope === 'user' ? '/api/skills' : `/api/projects/${projectId}/skills`
  const refresh = useCallback(() => {
    setLoading(true)
    api(baseUrl).then((arr: any[]) => { setSkills(Array.isArray(arr) ? arr : []); setLoading(false) })
      .catch(() => { setSkills([]); setLoading(false) })
  }, [baseUrl])

  useEffect(() => { refresh() }, [refresh])

  const closeAdd = () => {
    setAdding(false); setSkillName(''); setManualName(''); setManualDescription(''); setManualBody(''); setLocalPath(''); setErr(''); setImportInfo('')
  }

  const yamlScalar = (value: string) => {
    const oneLine = String(value || '').replace(/\r?\n/g, ' ').trim()
    return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  const safeFilenamePart = (value: string) => {
    const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return cleaned || 'custom-skill'
  }

  const buildManualSkillMarkdown = () => {
    const raw = manualBody.replace(/\r\n/g, '\n')
    if (/^\s*---\s*\n/.test(raw)) return raw
    const frontmatter = ['---', `name: ${yamlScalar(manualName)}`]
    if (manualDescription.trim()) frontmatter.push(`description: ${yamlScalar(manualDescription)}`)
    frontmatter.push('---', '')
    return frontmatter.join('\n') + raw
  }

  const submitManualSkill = async () => {
    const name = manualName.trim()
    if (!name) { setErr('Skill 名称不能为空'); return }
    if (!manualBody.trim()) { setErr('Skill 内容不能为空'); return }
    setErr(''); setImportInfo(''); setSubmitting(true)
    try {
      const r: any = await api(`${baseUrl}/import-file`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          content: buildManualSkillMarkdown(),
          filename: `${safeFilenamePart(name)}.md`,
        }),
      })
      const imported = Array.isArray(r?.skills) ? r.skills : []
      const skipped = Array.isArray(r?.skipped) ? r.skipped : []
      markContextSetupSkillImported(r)
      refresh()
      if (skipped.length > 0) {
        setImportInfo(
          `已处理 ${imported.length} 个: ${imported.map((s: any) => s.name).join(', ') || '无'}\n` +
          `跳过 ${skipped.length} 个: ${skipped.map((s: any) => `${s.name} (${s.reason})`).join('; ')}`
        )
      } else {
        closeAdd()
      }
    } catch (e: any) {
      setErr(e?.message || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const submitInstall = async () => {
    const name = skillName.trim()
    if (!name) { setErr('skill 名称不能为空'); return }
    setErr(''); setImportInfo(''); setSubmitting(true)
    try {
      await api(baseUrl, { method: 'POST', body: JSON.stringify({ name }) })
      closeAdd(); refresh()
    } catch (e: any) {
      setErr(e?.message || '安装失败')
    } finally {
      setSubmitting(false)
    }
  }

  const submitImportLocal = async () => {
    const p = localPath.trim()
    if (!p) { setErr('请输入 skill 的服务器绝对路径'); return }
    setErr(''); setImportInfo(''); setSubmitting(true)
    try {
      const r: any = await api(`${baseUrl}/import-local`, { method: 'POST', body: JSON.stringify({ path: p }) })
      const imported = Array.isArray(r?.skills) ? r.skills : []
      const skipped = Array.isArray(r?.skipped) ? r.skipped : []
      if (skipped.length > 0) {
        // 部分成功: 留在面板里展示结果, 不关闭
        setImportInfo(
          `已导入 ${imported.length} 个: ${imported.map((s: any) => s.name).join(', ') || '无'}\n` +
          `跳过 ${skipped.length} 个: ${skipped.map((s: any) => `${s.name} (${s.reason})`).join('; ')}`
        )
        setLocalPath('')
        refresh()
      } else {
        closeAdd(); refresh()
      }
      markContextSetupSkillImported({ skills: imported, skipped })
    } catch (e: any) {
      setErr(e?.message || '导入失败')
    } finally {
      setSubmitting(false)
    }
  }

  const markContextSetupSkillImported = (result: any) => {
    const state = readContextSetupDemoState()
    if (!state?.active || state.projectId !== projectId) return
    const imported = Array.isArray(result?.skills) ? result.skills : []
    const skipped = Array.isArray(result?.skipped) ? result.skipped : []
    const hasExpectedSkill = [...imported, ...skipped].some((item: any) => item?.name === state.skillName)
    if (!hasExpectedSkill) return
    patchContextSetupDemoState({ skillImportedAt: Date.now() })
    window.dispatchEvent(new CustomEvent(CONTEXT_SETUP_DEMO_TOUR_EVENT, { detail: { force: true } }))
  }

  const uploadSkillFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || (scope === 'project' && !projectId)) return
    setFileImporting(true)
    setFileImportInfo('')
    setErr('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const r: any = await api(`${baseUrl}/import-file`, {
        method: 'POST',
        body: formData,
      })
      const imported = Array.isArray(r?.skills) ? r.skills : []
      const skipped = Array.isArray(r?.skipped) ? r.skipped : []
      setFileImportInfo(
        `已处理 ${imported.length} 个: ${imported.map((s: any) => s.name).join(', ') || '无'}` +
        (skipped.length ? `；跳过 ${skipped.length} 个: ${skipped.map((s: any) => `${s.name} (${s.reason})`).join('; ')}` : '') +
        '。也可以从 GitHub 包安装、用本地绝对路径导入，或复制已有 Skill。'
      )
      markContextSetupSkillImported(r)
      refresh()
    } catch (e: any) {
      setFileImportInfo(e?.message || '上传导入失败')
    } finally {
      setFileImporting(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除该 skill? (会移除其 SKILL.md 所在目录)')) return
    try { await api(`${baseUrl}/${id}`, { method: 'DELETE' }); refresh() } catch (e: any) { alert(e?.message || '删除失败') }
  }

  const title = scope === 'user' ? '用户级 Skill' : '项目级 Skill'
  const desc = scope === 'user'
    ? '可直接写入或粘贴 SKILL.md 内容，也可上传 .md / skill 压缩包，或从 GitHub 包安装。这些 Skill 在你创建的所有 Issue 中默认可用'
    : '可直接写入或粘贴 SKILL.md 内容，也可上传 .md / skill 压缩包，或从 GitHub 包安装。只对本项目下后续创建的 Session 默认可用；已有 Session 已固定快照，不会自动补入。'
  const managerTour = scope === 'user' ? 'user-skill-manager' : 'project-skill-manager'
  const copyTour = scope === 'user' ? 'user-skill-copy' : 'project-skill-copy'
  const addTour = scope === 'user' ? 'user-skill-add' : 'project-skill-add'
  const visibilityLabel = (value: any, itemScope: string) => {
    if (value === 'inherit') return itemScope === 'project' ? '继承项目' : '仅自己'
    if (value === 'team') return '同组'
    if (value === 'public') return '公开'
    if (value === 'allowlist') return '指定用户'
    return '仅自己'
  }

  return (
    <div data-tour={managerTour} className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-[13px] font-semibold whitespace-nowrap flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        <div className="flex flex-shrink-0 gap-1">
          <input
            ref={skillFileInputRef}
            type="file"
            accept=".md,.markdown,.zip,.tar,.tar.gz,.tgz,.tbz,.tbz2,.tar.bz2,.txz,.tar.xz,text/markdown,application/zip,application/x-tar,application/gzip"
            className="hidden"
            onChange={uploadSkillFile}
          />
          <button
            onClick={() => skillFileInputRef.current?.click()}
            disabled={fileImporting || (scope === 'project' && !projectId)}
            data-tour={scope === 'user' ? 'user-skill-upload-file' : 'project-skill-upload-file'}
            className="text-[10.5px] px-1.5 py-1 rounded bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border border-sky-500/20 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title="上传本地 .md 或 skill 压缩包并导入为 Skill, 上限 1GB">
            <Upload className="w-3 h-3" strokeWidth={1.8} />
            {fileImporting ? '上传中...' : '上传文件'}
          </button>
          <button onClick={() => setCopyOpen(true)}
            data-tour={copyTour}
            className="text-[10.5px] px-1.5 py-1 rounded bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border border-violet-500/20 transition-colors whitespace-nowrap"
            title="浏览其他用户/项目的 skill 并复制到这里">
            复制
          </button>
          <button onClick={() => setAdding(true)}
            data-tour={addTour}
            className="text-[10.5px] px-1.5 py-1 rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 transition-colors whitespace-nowrap">
            添加
          </button>
        </div>
      </div>
      <p className="text-[12px] mb-4" style={{ color: 'var(--text-muted)' }}>{desc}</p>
      {fileImportInfo && (
        <pre className="text-[11px] text-amber-400 mb-3 whitespace-pre-wrap break-all max-h-24 overflow-auto">{fileImportInfo}</pre>
      )}

      {adding && (
        <div data-tour="skill-add-panel" className="mb-4 p-3 rounded-lg border" style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
          <div className="flex gap-1 mb-3">
            {([['manual', '直接编辑/粘贴'], ['github', 'Github 包'], ['local', '本地绝对路径']] as const).map(([m, label]) => (
              <button key={m} onClick={() => { setAddMode(m); setErr(''); setImportInfo('') }} disabled={submitting}
                data-tour={m === 'manual' ? 'skill-add-manual-tab' : m === 'github' ? 'skill-add-github-tab' : 'skill-add-local-tab'}
                className="text-[11px] px-2.5 py-1 rounded border transition-colors disabled:opacity-40"
                style={addMode === m
                  ? { background: 'var(--accent, #3b82f6)', color: '#fff', borderColor: 'transparent' }
                  : { color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                {label}
              </button>
            ))}
          </div>

          {addMode === 'manual' ? (
            <>
              <div>
                <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                  Skill 名称 (必填, 用于列表和目录名)
                </label>
                <input autoFocus value={manualName}
                  onChange={e => { setManualName(e.target.value); setErr(''); setImportInfo('') }}
                  data-tour="skill-add-manual-name-input"
                  placeholder="例: playwright-debugging"
                  disabled={submitting}
                  className="w-full px-2.5 py-1.5 rounded text-[12px] font-mono mb-2 focus:outline-none focus:border-blue-500/30 disabled:opacity-40"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                  简短说明 (选填)
                </label>
                <input value={manualDescription}
                  onChange={e => { setManualDescription(e.target.value); setErr(''); setImportInfo('') }}
                  data-tour="skill-add-manual-description-input"
                  placeholder="例: 调试前端页面时使用 Playwright 截图和控制台日志"
                  disabled={submitting}
                  className="w-full px-2.5 py-1.5 rounded text-[12px] mb-2 focus:outline-none focus:border-blue-500/30 disabled:opacity-40"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                  Skill 内容 (Markdown，可直接粘贴完整 SKILL.md；没有 frontmatter 时会自动补上名称和说明)
                </label>
                <textarea value={manualBody}
                  onChange={e => { setManualBody(e.target.value); setErr(''); setImportInfo('') }}
                  data-tour="skill-add-manual-body-input"
                  placeholder={'写清这个 Skill 适合什么时候使用、执行步骤、注意事项。也可以直接粘贴已有 SKILL.md 内容。'}
                  disabled={submitting}
                  rows={12}
                  className="w-full px-2.5 py-2 rounded text-[12px] font-mono leading-relaxed mb-2 focus:outline-none focus:border-blue-500/30 disabled:opacity-40 resize-y"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
              </div>
            </>
          ) : addMode === 'github' ? (
            <>
              <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                Skill 包标识 (将作为 <code>npx --yes skills add &lt;package&gt;</code> 参数; 格式 <code>owner/repo</code> 或 <code>owner/repo@skill-name</code>)
              </label>
              <input autoFocus value={skillName}
                onChange={e => { setSkillName(e.target.value); setErr('') }}
                onKeyDown={e => { if (e.key === 'Enter' && !submitting) submitInstall() }}
                data-tour="skill-add-package-input"
                placeholder="例: vercel-labs/agent-skills 或 owner/repo@skill-name"
                disabled={submitting}
                className="w-full px-2.5 py-1.5 rounded text-[12px] font-mono mb-2 focus:outline-none focus:border-blue-500/30 disabled:opacity-40"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
            </>
          ) : (
            <>
              <label className="text-[11px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                服务器本地绝对路径 — 可指向 <code>含 SKILL.md 的目录</code> / <code>.md 文件</code> / <code>skill 压缩包</code> / <code>含多个 skill 子目录的父目录</code> (批量导入)。压缩包或目录上限 1GB; 复制为快照, 与源解耦。
              </label>
              <input autoFocus value={localPath}
                onChange={e => { setLocalPath(e.target.value); setErr(''); setImportInfo('') }}
                onKeyDown={e => { if (e.key === 'Enter' && !submitting) submitImportLocal() }}
                data-tour="skill-add-local-input"
                placeholder="例: /home/alice/my-skills/awesome-skill"
                disabled={submitting}
                className="w-full px-2.5 py-1.5 rounded text-[12px] font-mono mb-2 focus:outline-none focus:border-blue-500/30 disabled:opacity-40"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
            </>
          )}

          {err && <pre className="text-[11px] text-red-400 mb-2 whitespace-pre-wrap break-all max-h-40 overflow-auto">{err}</pre>}
          {importInfo && <pre className="text-[11px] text-amber-400 mb-2 whitespace-pre-wrap break-all max-h-40 overflow-auto">{importInfo}</pre>}
          <div className="flex gap-2">
            {addMode === 'manual' ? (
              <button onClick={submitManualSkill} disabled={submitting || !manualName.trim() || !manualBody.trim()}
                className="h-7 px-3 text-[11px] rounded btn-primary transition-colors disabled:opacity-40">
                {submitting ? '创建中...' : '创建 Skill'}
              </button>
            ) : addMode === 'github' ? (
              <button onClick={submitInstall} disabled={submitting || !skillName.trim()}
                className="h-7 px-3 text-[11px] rounded btn-primary transition-colors disabled:opacity-40">
                {submitting ? '安装中... (npx 可能耗时)' : '安装'}
              </button>
            ) : (
              <button onClick={submitImportLocal} disabled={submitting || !localPath.trim()}
                className="h-7 px-3 text-[11px] rounded btn-primary transition-colors disabled:opacity-40">
                {submitting ? '导入中...' : '导入'}
              </button>
            )}
            <button onClick={closeAdd} disabled={submitting}
              className="h-7 px-3 text-[11px] rounded border disabled:opacity-40"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>取消</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : skills.length === 0 ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>暂无 skill, 点击右上角添加</div>
      ) : (
        <div className="space-y-2">
          {skills.map((sk: any) => (
            <div key={sk.id} className="p-3 bg-[var(--bg-card)] rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-[180px] flex-[1_1_180px]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
                    <span className="min-w-32 max-w-full flex-[1_1_8rem] text-[13px] font-medium leading-5 break-words" style={{ color: 'var(--text-primary)' }}>{sk.name}</span>
                    {typeof sk.body_length === 'number' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>
                        {sk.body_length} 字符
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: '#60a5fa', background: 'rgba(96,165,250,0.08)' }}>
                      {visibilityLabel(sk.visibility, sk.scope)}
                    </span>
                  </div>
                  {sk.description && (
                    <p className="text-[11px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{sk.description}</p>
                  )}
                </div>
                <div className="ml-auto flex flex-[0_1_auto] flex-wrap items-center justify-end gap-1">
                  <button onClick={() => setViewing(sk)} title="查看 SKILL.md"
                    className="h-7 px-2 text-[11px] rounded border transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>查看</button>
                  {sk.can_manage && (
                    <button onClick={() => setAccessing(sk)} title="设置可见性和指定用户"
                      className="h-7 px-2 text-[11px] rounded border transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>权限</button>
                  )}
                  <button onClick={() => setMoving(sk)} title={scope === 'user' ? '移到项目级' : '移到我的 / 其他项目'}
                    className="h-7 px-2 text-[11px] rounded border transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>移动</button>
                  <button onClick={() => handleDelete(sk.id)} title="移除"
                    className="h-7 px-2 text-[11px] rounded border hover:bg-red-500/10 hover:text-red-400 transition-colors" style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>移除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewing && <SkillBodyViewer baseUrl={baseUrl} skillId={viewing.id} title={viewing.name} onClose={() => setViewing(null)} />}

      {accessing && (
        <ContextAccessModal
          baseUrl={baseUrl}
          item={accessing}
          kindLabel="Skill"
          onClose={() => setAccessing(null)}
          onSaved={() => { setAccessing(null); refresh() }}
        />
      )}

      {moving && (
        <MoveScopeModal
          title={`移动 Skill: ${moving.name}`}
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
          kind="skill"
          catalogUrl="/api/skills/catalog"
          copyUrl={`${baseUrl}/copy`}
          targetLabel={title}
          onClose={() => setCopyOpen(false)}
          onCopied={refresh}
        />
      )}
    </div>
  )
}

// 单条 skill 详情查看 (带 body)
function SkillBodyViewer({ baseUrl, skillId, title, onClose }: { baseUrl: string; skillId: string; title: string; onClose: () => void }) {
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  useEffect(() => {
    api(`${baseUrl}/${skillId}`)
      .then((d: any) => { setBody(d?.body || ''); setLoading(false) })
      .catch(e => { setErr(e?.message || '加载失败'); setLoading(false) })
  }, [baseUrl, skillId])
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[760px] max-h-[80vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title} · SKILL.md</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors" style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {loading ? <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            : err ? <div className="text-[12px] text-red-400">{err}</div>
            : <pre className="text-[12px] leading-relaxed whitespace-pre-wrap font-mono p-4 rounded-xl border"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>{body}</pre>}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// IssueSkillSelector — Issue 视角的 skill 启用 / 排除
// 三种状态: 默认 (跟随用户/项目级配置) / 仅启用 (selected) / 排除 (excluded)
// 通过 PATCH /api/issues/:id 持久化
// =====================================================================
export function IssueSkillSelector({ issueId, onChange }: { issueId: string; onChange?: () => void }) {
  const [data, setData] = useState<{ available: any[]; selected: string[]; excluded: string[]; effective: any[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    api(`/api/issues/${issueId}/skills`).then((d: any) => { setData(d); setLoading(false) })
      .catch(() => { setData(null); setLoading(false) })
  }, [issueId])

  useEffect(() => { refresh() }, [refresh])

  const persist = async (selected: string[], excluded: string[]) => {
    setSaving(true)
    try {
      await api(`/api/issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ selected_skills: selected, excluded_skills: excluded }),
      })
      onChange?.()
      refresh()
    } finally { setSaving(false) }
  }

  if (loading || !data) {
    return <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>加载 skill...</div>
  }
  if (data.available.length === 0) {
    return (
      <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>
        暂无可用 skill. 在「用户中心」或项目设置中添加.
      </div>
    )
  }

  const selectedSet = new Set(data.selected)
  const excludedSet = new Set(data.excluded)
  const usingWhitelist = data.selected.length > 0

  type State = 'default' | 'selected' | 'excluded'
  const stateOf = (id: string): State => {
    if (excludedSet.has(id)) return 'excluded'
    if (selectedSet.has(id)) return 'selected'
    return 'default'
  }
  const cycle = (id: string) => {
    let nextSel = data.selected.slice()
    let nextExc = data.excluded.slice()
    const cur = stateOf(id)
    nextSel = nextSel.filter(x => x !== id)
    nextExc = nextExc.filter(x => x !== id)
    if (cur === 'default') nextSel.push(id)
    else if (cur === 'selected') nextExc.push(id)
    persist(nextSel, nextExc)
  }
  const clearAll = () => persist([], [])

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          Skill ({data.effective.length}/{data.available.length} 启用)
        </span>
        {(data.selected.length > 0 || data.excluded.length > 0) && (
          <button onClick={clearAll} disabled={saving}
            className="text-[10px] px-1.5 py-0.5 rounded border hover:bg-[var(--bg-hover)] transition-colors"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
            重置
          </button>
        )}
      </div>
      <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
        {usingWhitelist ? '白名单模式: 只有勾选的 skill 会注入' : '默认模式: 全部启用, 标记为排除的不注入'}
      </p>
      <div className="space-y-1">
        {data.available.map((sk: any) => {
          const st = stateOf(sk.id)
          const colors = st === 'selected'
            ? { bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.4)', text: '#22c55e', label: '✓ 启用' }
            : st === 'excluded'
            ? { bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.4)', text: '#ef4444', label: '✕ 排除' }
            : { bg: 'transparent', border: 'var(--input-border)', text: 'var(--text-muted)', label: '默认' }
          return (
            <button key={sk.id} onClick={() => cycle(sk.id)} disabled={saving}
              className="w-full text-left p-2 rounded-md border transition-colors hover:bg-[var(--bg-card-hover)]"
              style={{ background: colors.bg, borderColor: colors.border }}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{sk.name}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded flex-shrink-0" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)' }}>
                      {sk.scope === 'project' ? '项目' : '用户'}
                    </span>
                  </div>
                  {sk.description && (
                    <p className="text-[10px] line-clamp-1 mt-0.5" style={{ color: 'var(--text-muted)' }}>{sk.description}</p>
                  )}
                </div>
                <span className="text-[10px] flex-shrink-0" style={{ color: colors.text }}>{colors.label}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
