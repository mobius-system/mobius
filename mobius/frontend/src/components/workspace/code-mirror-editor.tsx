import { useCallback, useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import type { Extension, Text } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { syntaxHighlighting } from '@codemirror/language'

export type CodeSkinKey = 'dark' | 'light'

type CodeMirrorEditorProps = {
  fileName: string
  value: string
  skin: CodeSkinKey
  onChange: (value: string) => void
  /** 是否开启自动换行; 默认 false (一行就是一行, 长行横向滚动, 对齐 VS Code 默认 wordWrap=off). */
  wrap?: boolean
  /** Alt+Z / 工具栏按钮触发的切换回调. */
  onToggleWrap?: () => void
  /** 显式从文件预览进入编辑器时的初始源码位置；普通文件树点击不传。 */
  initialLine?: number | null
  initialColumn?: number | null
  initialEndLine?: number | null
  /** 即使路径和范围相同，也允许一次新的显式打开请求重新定位。 */
  initialLocationKey?: string | number | null
}

export type CodeEditorSelection = { anchor: number; head: number }

/** 把 1-based 文件位置转成 CodeMirror offset，并把越界位置夹到当前文档。 */
export function editorSelectionForLocation(
  doc: Text,
  line: number | null | undefined,
  column?: number | null,
  endLine?: number | null,
): CodeEditorSelection | null {
  if (!Number.isFinite(line) || Number(line) < 1 || doc.lines < 1) return null
  const startNumber = Math.max(1, Math.min(doc.lines, Math.trunc(Number(line))))
  const startLine = doc.line(startNumber)
  const requestedColumn = Number.isFinite(column) && Number(column) > 0 ? Math.trunc(Number(column)) : 1
  const anchor = Math.min(startLine.to, startLine.from + requestedColumn - 1)
  if (!Number.isFinite(endLine) || Number(endLine) < 1) return { anchor, head: anchor }
  const endNumber = Math.max(startNumber, Math.min(doc.lines, Math.trunc(Number(endLine))))
  return { anchor, head: doc.line(endNumber).to }
}

const main_text_color_dark = '#c9c9c9'

// light 模式的编辑器主题: 背景与代码区外壳 #ffffff 匹配, 语法高亮由 basicSetup
// 的 defaultHighlightStyle 提供, 与 dark 模式的 oneDark token 高亮对称.
const lightEditorTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#2c2c2c', height: '100%' },
  '.cm-gutters': { backgroundColor: '#ffffff', color: '#9a9a9a', border: 'none', borderRight: '1px solid #e6e6e6' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
  '.cm-activeLineGutter': { backgroundColor: '#ffffff', color: '#2c2c2c' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(37,99,235,0.2)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(37,99,235,0.2)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: '#f0f0f0', border: '1px solid #e6e6e6', color: '#9a9a9a' },
})

// dark 模式的背景/前景覆盖层: token 高亮用 oneDarkHighlightStyle, 背景和 gutter
// 由这里统一覆盖, 避免 oneDark 默认背景与外壳颜色竞争.
const darkSkinOverride = EditorView.theme({
  '&': { backgroundColor: '#121419', color: main_text_color_dark },
  '.cm-gutters': { backgroundColor: '#121419', color: '#7d8799', border: 'none' },
  '.cm-activeLine': { backgroundColor: '#ffffff08' },
  '.cm-activeLineGutter': { backgroundColor: '#121419', color: main_text_color_dark },
  '.cm-content': { caretColor: main_text_color_dark },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: main_text_color_dark },
  '.cm-selectionBackground': { backgroundColor: '#3a3d5a' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: '#3a3d5a' },
  '.cm-foldPlaceholder': { backgroundColor: '#1a1c22', border: '1px solid #2a2d3e', color: '#7d8799' },
  '.cm-panels': { backgroundColor: '#121419', color: main_text_color_dark },
  '.cm-tooltip': { backgroundColor: '#1f222a', color: main_text_color_dark },
}, { dark: true })

function langKeyForFile(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'js'
  if (['ts', 'tsx'].includes(ext)) return 'ts'
  if (ext === 'py') return 'py'
  if (['md', 'markdown'].includes(ext)) return 'md'
  if (ext === 'json') return 'json'
  if (['css', 'scss', 'less'].includes(ext)) return 'css'
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return 'html'
  if (ext === 'sql') return 'sql'
  return null
}

// 语言包继续按文件类型动态加载: 打开 TS 文件不会提前下载 Python/Markdown/SQL 文法.
const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  js: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true })),
  py: () => import('@codemirror/lang-python').then(m => m.python()),
  md: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  json: () => import('@codemirror/lang-json').then(m => m.json()),
  css: () => import('@codemirror/lang-css').then(m => m.css()),
  html: () => import('@codemirror/lang-html').then(m => m.html()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
}

export function CodeMirrorEditor({
  fileName,
  value,
  skin,
  onChange,
  wrap = false,
  onToggleWrap,
  initialLine = null,
  initialColumn = null,
  initialEndLine = null,
  initialLocationKey = null,
}: CodeMirrorEditorProps) {
  const [langExt, setLangExt] = useState<Extension | null>(null)
  const [editorView, setEditorView] = useState<EditorView | null>(null)

  useEffect(() => {
    const key = langKeyForFile(fileName)
    if (!key) {
      setLangExt(null)
      return
    }
    let cancelled = false
    LANG_LOADERS[key]()
      .then(ext => { if (!cancelled) setLangExt(ext) })
      .catch(() => { if (!cancelled) setLangExt(null) })
    return () => { cancelled = true }
  }, [fileName])

  const theme: 'none' | typeof lightEditorTheme = skin === 'dark' ? 'none' : lightEditorTheme
  const extensions = useMemo(() => {
    // Alt+Z 切换自动换行, 对齐 VS Code 的 toggleWordWrap. 默认关 (一行就是一行, 长行横向滚动).
    const keybindings: KeyBinding[] = [indentWithTab]
    if (onToggleWrap) {
      keybindings.push({ key: 'Alt-z', preventDefault: true, run: () => { onToggleWrap(); return true } })
    }
    const base = [
      keymap.of(keybindings),
      ...(wrap ? [EditorView.lineWrapping] : []),
      ...(langExt ? [langExt] : []),
    ]
    return skin === 'dark' ? [...base, darkSkinOverride, syntaxHighlighting(oneDarkHighlightStyle)] : base
  }, [langExt, skin, wrap, onToggleWrap])

  const captureEditorView = useCallback((view: EditorView) => {
    setEditorView(view)
  }, [])

  useEffect(() => {
    if (!editorView || initialLine === null) return
    // @uiw/react-codemirror 同一轮还会把新的 value 写入 view；下一帧再按最终 doc 定位，
    // 避免切文件时用上一份文档的行数计算 selection。
    const frame = window.requestAnimationFrame(() => {
      const selection = editorSelectionForLocation(editorView.state.doc, initialLine, initialColumn, initialEndLine)
      if (!selection) return
      editorView.dispatch({
        selection,
        effects: EditorView.scrollIntoView(selection.anchor, { y: 'center' }),
      })
      editorView.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [editorView, fileName, initialColumn, initialEndLine, initialLine, initialLocationKey])

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      onCreateEditor={captureEditorView}
      theme={theme}
      extensions={extensions}
      height="100%"
      style={{ height: '100%', fontSize: '12.5px' }}
    />
  )
}
