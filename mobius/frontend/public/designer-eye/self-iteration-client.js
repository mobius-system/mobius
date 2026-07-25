const REQUEST_TIMEOUT_MS = 12_000

function authHeaders(json = false) {
  const token = localStorage.getItem('cc-token') || ''
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function api(path, options = {}) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(path, {
      credentials: 'include',
      ...options,
      signal: controller.signal,
      headers: {
        ...authHeaders(options.body !== undefined),
        ...(options.headers || {}),
      },
    })
    let data = null
    try { data = await response.json() } catch { data = null }
    if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}）`)
    return data
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求超时，请稍后重试')
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function currentRouteIds() {
  const match = location.pathname.match(/^\/u\/([^/]+)\/p\/([^/]+)\/i\/([^/?]+)/)
  return match
    ? { userId: decodeURIComponent(match[1]), projectId: decodeURIComponent(match[2]), issueId: decodeURIComponent(match[3]) }
    : { userId: '', projectId: '', issueId: '' }
}

function isDesignerSelfIterationProject(project) {
  const id = String(project?.id || '')
  return project?.is_self_develop === true
    && project?.kind !== 'extension'
    && !id.startsWith('ext_')
    && !id.startsWith('xm-')
}

function normalizeOptions(items, kind) {
  return (Array.isArray(items) ? items : []).map(item => ({
    id: String(item.id || ''),
    name: String(item.name || item.title || item.id || ''),
    description: String(item.description || ''),
    scope: String(item.scope || 'project'),
    dirName: kind === 'skill' ? String(item.dirName || '') : '',
  })).filter(item => item.id)
}

export async function loadSelfIterationBootstrap() {
  const [projectPayload, modelPayload, defaultModelPayload, me] = await Promise.all([
    api('/api/projects?all=true'),
    api('/api/sessions/model-options'),
    api('/api/sessions/default-model').catch(() => ({ model: null })),
    api('/api/auth/me'),
  ])
  const projects = (Array.isArray(projectPayload) ? projectPayload : (projectPayload?.projects || []))
    .filter(isDesignerSelfIterationProject)
  const models = (Array.isArray(modelPayload) ? modelPayload : []).map(model => ({
    key: String(model.key || ''),
    title: String(model.title || model.label || model.key || ''),
    sub: String(model.sub || ''),
    backend: String(model.backend || ''),
  })).filter(model => model.key)
  return {
    projects,
    models,
    globalDefaultModel: typeof defaultModelPayload?.model === 'string' ? defaultModelPayload.model : '',
    userId: String(me?.id || currentRouteIds().userId || ''),
    route: currentRouteIds(),
  }
}

export async function loadProjectIssues(projectId) {
  if (!projectId) return []
  const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/issues?status=active`)
  return (Array.isArray(payload) ? payload : (payload?.issues || []))
    .filter(issue => issue && String(issue.status || 'active') === 'active')
}

export async function loadIssueContext(issueId, prompt) {
  if (!issueId) return { skills: [], memories: [], defaults: {} }
  const payload = await api(`/api/issues/${encodeURIComponent(issueId)}/context-preview`, {
    method: 'POST',
    body: JSON.stringify({
      name: '设计师之眼',
      description: prompt || ' ',
      excluded_skill_ids: [],
      excluded_memory_ids: [],
      include_defaults: true,
      include_body: false,
      include_item_bodies: false,
    }),
  })
  return {
    skills: normalizeOptions(payload?.sources?.skills, 'skill'),
    memories: normalizeOptions(payload?.sources?.memories, 'memory'),
    defaults: payload?.defaults || {},
  }
}

function sessionName(issueTitle) {
  const now = new Date()
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now).replace(/\//g, '-').replace(/\s+/g, ' ')
  return `设计师之眼 · ${issueTitle || '界面优化'} · ${stamp}`
}

export async function createAndStartSelfIteration({
  project,
  issue,
  model,
  prompt,
  skills,
  memories,
  selectedSkillIds,
  selectedMemoryIds,
  userId,
}) {
  if (!isDesignerSelfIterationProject(project)) throw new Error('请选择 Mobius 自进化项目')
  if (!issue?.id || String(issue.project_id) !== String(project.id)) throw new Error('请选择该项目下的 Mobius Issue')
  if (!model) throw new Error('请选择模型')
  if (!String(prompt || '').trim()) throw new Error('提示词不能为空')

  const enabledSkills = new Set(selectedSkillIds || [])
  const enabledMemories = new Set(selectedMemoryIds || [])
  const excludedSkillIds = (skills || []).map(item => item.id).filter(id => !enabledSkills.has(id))
  const excludedMemoryIds = (memories || []).map(item => item.id).filter(id => !enabledMemories.has(id))
  const name = sessionName(issue.title)
  const session = await api(`/api/issues/${encodeURIComponent(issue.id)}/sessions`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: prompt,
      model,
      language: 'zh',
      excluded_skill_ids: excludedSkillIds,
      excluded_memory_ids: excludedMemoryIds,
    }),
  })
  const sessionId = String(session?.session_id || '')
  if (!sessionId) throw new Error('会话已创建，但服务端未返回 Session ID')

  const startContent = [name, prompt].filter(Boolean).join('\n\n')
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: startContent,
      input_text: startContent,
      request_id: `designer-eye-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
  })

  const owner = userId || currentRouteIds().userId
  const detailUrl = owner
    ? `/u/${encodeURIComponent(owner)}/p/${encodeURIComponent(project.id)}/i/${encodeURIComponent(issue.id)}?session=${encodeURIComponent(sessionId)}`
    : ''
  return { sessionId, name, detailUrl }
}

export { isDesignerSelfIterationProject }
