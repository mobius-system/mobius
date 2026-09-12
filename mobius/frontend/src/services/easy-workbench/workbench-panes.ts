import { useSyncExternalStore } from 'react'

// 极简工作台「左栏收起 + 右栏统一开闭」的轻量全局状态。
// 右栏只有一个: rightPane 指明当前显示工具抽屉还是扩展浏览器面板。
// 顶栏开关、easy-chat、EasyWorkPage 分属不同组件子树 (portal 也只保持 DOM 挂点),
// 用模块级 store + useSyncExternalStore 让它们共享同一份开闭状态, 避免两套右栏各自为政。

export type RightPaneKind = 'tools' | 'extension' | 'vscode' | 'editor'

export type ExtensionPanelState = {
  name: string
  displayName: string
  url: string
}

/** 右栏文档编辑器面板的目标: 项目内相对路径 (空串 = 未选文件, 显示文件树空态)。 */
export type EditorPanelState = {
  projectId: string
  path: string
}

type WorkbenchPanesState = {
  railCollapsed: boolean
  rightOpen: boolean
  rightPane: RightPaneKind
  extension: ExtensionPanelState | null
  editor: EditorPanelState | null
}

const RAIL_COLLAPSED_STORAGE_KEY = 'mobius:ui:workbench:rail-collapsed'

function readRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistRailCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, value ? '1' : '0')
  } catch { /* 偏好存储不可用时仅本次生效 */ }
}

let state: WorkbenchPanesState = {
  railCollapsed: readRailCollapsed(),
  rightOpen: false,
  rightPane: 'tools',
  extension: null,
  editor: null,
}

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach(listener => listener())
}

function patch(next: Partial<WorkbenchPanesState>) {
  state = { ...state, ...next }
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot() {
  return state
}

export function useWorkbenchPanes() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function toggleRail() {
  patch({ railCollapsed: !state.railCollapsed })
  persistRailCollapsed(state.railCollapsed)
}

/** 展开右栏并显示工具抽屉。 */
export function openRightTools() {
  patch({ rightOpen: true, rightPane: 'tools' })
}

/** 展开右栏并显示扩展浏览器面板 (payload 替换当前面板内容)。 */
export function openRightExtension(extension: ExtensionPanelState) {
  patch({ rightOpen: true, rightPane: 'extension', extension })
}

/** 展开右栏并显示 VSCode 工作区面板 (code-server iframe, 元数据由面板自取)。 */
export function openRightVscode() {
  patch({ rightOpen: true, rightPane: 'vscode' })
}

/** 展开右栏并显示原生文档编辑器 (可选携带初始文件路径)。 */
export function openRightEditor(editor: EditorPanelState) {
  patch({ rightOpen: true, rightPane: 'editor', editor })
}

/** 右栏文档编辑器已打开时, 替换正在编辑的文件路径。 */
export function setRightEditorPath(path: string) {
  if (!state.editor) return
  patch({ editor: { ...state.editor, path } })
}

/** 收起右栏 (保留当前面板与扩展内容, 便于原样恢复)。 */
export function closeRight() {
  patch({ rightOpen: false })
}

/** 彻底复位右栏: 收起、切回工具抽屉并丢弃扩展/编辑器面板内容 (离开会话页/切换会话时)。 */
export function resetRightPane() {
  patch({ rightOpen: false, rightPane: 'tools', extension: null, editor: null })
}
