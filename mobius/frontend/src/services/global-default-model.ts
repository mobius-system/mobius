// 全局默认模型偏好 (管理员在"管理中心-系统设置"选择) 的前端读取助手.
//
// 新建 Session / 快捷新建 / 小莫 的模型默认值优先级:
//   用户/草稿选择 > 项目级 default_model > 全局默认模型 > 内置 'codex'.
// 本助手只负责拉取"全局默认模型"这一级 (其余级由各表单组件自行处理).
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
