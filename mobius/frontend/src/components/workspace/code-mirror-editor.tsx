import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { syntaxHighlighting } from '@codemirror/language'

export type CodeSkinKey = 'dark' | 'light'

type CodeMirrorEditorProps = {
  fileName: string
  value: string
  skin: CodeSkinKey
  onChange: (value: string) => void
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

export function CodeMirrorEditor({ fileName, value, skin, onChange }: CodeMirrorEditorProps) {
  const [langExt, setLangExt] = useState<Extension | null>(null)

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
    const base = [
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
      ...(langExt ? [langExt] : []),
    ]
    return skin === 'dark' ? [...base, darkSkinOverride, syntaxHighlighting(oneDarkHighlightStyle)] : base
  }, [langExt, skin])

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={theme}
      extensions={extensions}
      height="100%"
      style={{ height: '100%', fontSize: '12.5px' }}
    />
  )
}
