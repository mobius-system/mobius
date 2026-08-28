// 全局默认模型偏好 (管理员在"管理中心-系统设置"选择) 的前端读取助手.
//
// 新建 Session / Research Agent / 小莫 的"模型默认值"统一三级优先级:
//   当前 issue/research 内上次所选模型 > 项目级 default_model > 全局默认模型 > 内置 'codex'.
//
// 关键约束: "当前 issue/research 内上次所选模型"的影响范围必须严格限定在当前 issue/research 内部,
// 不得对其他 issue、其他项目、甚至新创建的项目造成影响. 该值取自该作用域最近一次 Session 的 model
// (后端 session-selection-defaults 返回, 见 services/session-context.ts), 服务端天然按 issue/research
// 隔离, 且前端不把它写入任何跨作用域草稿, 故绝不会泄漏.
//
// 模块级缓存一次结果: 全局默认极少变化, 同一次页面加载内复用; 刷新页面会重新拉取.
// 端点 GET /api/sessions/default-model 返回 { model: <key>|null }; 未设置/失败时本助手返回 ''.
import { api } from '../store'

let cache: Promise<string> | null = null

export function fetchGlobalDefaultModel(): Promise<string> {
  if (!cache) {
    cache = api('/api/sessions/default-model')
      .then((r: any) => (r && typeof r.model === 'string' && r.model.trim() ? r.model.trim() : ''))
      .catch(() => '')
  }
  return cache
}

// 取"非空白字符串", 否则视为空.
function nonBlank(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

// 统一的三级模型默认值解析: 当前作用域上次所选 > 项目默认 > 全局默认 > fallback(默认 'codex').
// 所有"新建 Session / Research Agent"表单都应通过本函数计算模型初值, 保证优先级一致、不泄漏.
export function resolveDefaultModelKey(opts: {
  scopeLastModel?: string | null
  projectDefaultModel?: string | null
  globalDefaultModel?: string | null
  fallback?: string
}): string {
  const { scopeLastModel, projectDefaultModel, globalDefaultModel, fallback = 'codex' } = opts || {}
  return nonBlank(scopeLastModel) || nonBlank(projectDefaultModel) || nonBlank(globalDefaultModel) || nonBlank(fallback) || 'codex'
}

