import { api, useStore } from '../store'
import { composeConversationPrompt, type ConversationPromptAttachment } from './conversation-prompt'

export { composeConversationPrompt }
export type { ConversationPromptAttachment }

export type ConversationCreationStage = 'issue' | 'session'

export type ConversationCreationCheckpoint = {
  projectId: string
  issueId?: string
  sessionId?: string
  requestId: string
}

export type CreatedConversation = ConversationCreationCheckpoint & {
  issueId: string
  sessionId: string
}

export class ConversationCreationError extends Error {
  stage: ConversationCreationStage
  checkpoint: ConversationCreationCheckpoint

  constructor(stage: ConversationCreationStage, checkpoint: ConversationCreationCheckpoint, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause || '未知错误')
    const stageLabel = stage === 'issue' ? '创建默认任务' : '创建会话'
    super(`${stageLabel}失败：${causeMessage}`)
    this.name = 'ConversationCreationError'
    this.stage = stage
    this.checkpoint = checkpoint
  }
}

function conciseTitle(prompt: string) {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() || '新任务'
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

function normalizedLanguage(value: unknown): 'zh' | 'en' | null {
  return value === 'en' ? 'en' : value === 'zh' ? 'zh' : null
}

async function projectDefaults(projectId: string): Promise<any | null> {
  const cached = useStore.getState().projects.find((project: any) => project.id === projectId)
  if (cached) return cached
  try {
    const value = await api('/api/projects?all=true')
    const projects = Array.isArray(value) ? value : (value?.projects || [])
    return projects.find((project: any) => project.id === projectId) || null
  } catch {
    // 默认值读取失败不应阻断创建；后端仍会应用自身的安全回退。
    return null
  }
}

export async function createDefaultConversation(args: {
  projectId: string
  prompt: string
  attachments?: ConversationPromptAttachment[]
  /** 用户显式选择的模型/Harness 组合；缺省时继续沿用项目与系统默认链。 */
  model?: string
  checkpoint?: ConversationCreationCheckpoint | null
}): Promise<CreatedConversation> {
  const userPrompt = args.prompt.trim()
  const prompt = composeConversationPrompt(userPrompt, args.attachments)
  const checkpoint: ConversationCreationCheckpoint = args.checkpoint?.projectId === args.projectId
    ? { ...args.checkpoint }
    : {
        projectId: args.projectId,
        requestId: `home-start-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }
  const title = conciseTitle(userPrompt)
  const project = await projectDefaults(args.projectId)

  if (!checkpoint.issueId) {
    try {
      const issue = await api(`/api/projects/${args.projectId}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          description: prompt,
          use_worktree: !!project?.default_use_worktree,
          worktree_branch: '',
          visibility: 'private',
          is_planning: false,
        }),
      })
      if (!issue?.id) throw new Error(issue?.error || '服务未返回任务 ID')
      checkpoint.issueId = issue.id
    } catch (error) {
      throw new ConversationCreationError('issue', checkpoint, error)
    }
  }

  if (!checkpoint.sessionId) {
    try {
      // 复用现有上下文预览的默认链：同任务上次会话 → 项目默认 → 全局默认。
      // 预览失败时让创建接口自行回落，避免一个只读辅助请求阻断主路径。
      const defaults = await api(`/api/issues/${checkpoint.issueId}/context-preview`, {
        method: 'POST',
        body: JSON.stringify({
          name: title,
          description: prompt,
          excluded_skill_ids: [],
          excluded_memory_ids: [],
          include_defaults: true,
          include_body: false,
          include_item_bodies: false,
        }),
      }).then((preview: any) => preview?.defaults || {}).catch(() => ({}))
      const sourceSessionId = String(defaults?.source_session?.session_id || '')
      const sourceSession = sourceSessionId
        ? await api(`/api/tasks/${encodeURIComponent(sourceSessionId)}`).catch(() => null)
        : null
      const requestedModel = String(args.model || '').trim()
      const model = requestedModel || defaults.model || defaults.project_default_model || project?.default_model || undefined
      const language = normalizedLanguage(defaults.language)
        || normalizedLanguage(sourceSession?.language)
        || normalizedLanguage(project?.default_language)
        || normalizedLanguage(project?.language)
        || 'zh'
      const session = await api(`/api/issues/${checkpoint.issueId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          name: title,
          description: prompt,
          model,
          language,
          excluded_skill_ids: Array.isArray(defaults.excluded_skill_ids) ? defaults.excluded_skill_ids : [],
          excluded_memory_ids: Array.isArray(defaults.excluded_memory_ids) ? defaults.excluded_memory_ids : [],
          // Session 和首条用户消息一并落库；后端收到后异步唤醒 Agent，
          // 因此本请求只等待“会话可打开”，不再等待耗时的进程启动。
          initial_message: {
            content: prompt,
            request_id: checkpoint.requestId,
            mentions: [],
          },
        }),
      })
      if (!session?.session_id) throw new Error(session?.error || '服务未返回会话 ID')
      checkpoint.sessionId = session.session_id
    } catch (error) {
      throw new ConversationCreationError('session', checkpoint, error)
    }
  }

  return checkpoint as CreatedConversation
}
