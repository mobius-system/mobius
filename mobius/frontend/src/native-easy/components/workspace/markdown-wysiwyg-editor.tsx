import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Link } from '@tiptap/extension-link'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import type { CSSProperties } from 'react'
import type { CodeSkinKey } from './code-mirror-editor'

type Props = { value: string; skin: CodeSkinKey; onChange: (md: string) => void }

// 配色跟随代码区 skin (与 code-conversation-pane 的 CODE_SKINS 对齐).
// 在外层根元素覆盖 prose-chat 依赖的 CSS 变量, 让 WYSIWYG 渲染的 markdown 在深/浅代码区
// 都正确显示, 不依赖全局主题 (代码区明暗本就独立于全局主题). 与原只读预览同一套配色.
const WYSIWYG_VARS: Record<CodeSkinKey, CSSProperties> = {
  dark: {
    background: '#121419',
    color: '#c9c9c9',
    '--text-primary': '#c9c9c9',
    '--text-muted': '#7d8799',
    '--text-secondary': '#aeb4c0',
    '--prose-heading': '#e6e6e6',
    '--prose-code-color': '#c9c9c9',
    '--prose-code-bg': 'rgba(255,255,255,0.08)',
    '--code-bg': '#0f1116',
    '--code-text': '#c9c9c9',
    '--code-border': '#1f222a',
    '--border-color': '#1f222a',
  } as CSSProperties,
  light: {
    background: '#ffffff',
    color: '#2c2c2c',
    '--text-primary': '#2c2c2c',
    '--text-muted': '#9a9a9a',
    '--text-secondary': '#555555',
    '--prose-heading': '#111111',
    '--prose-code-color': '#2c2c2c',
    '--prose-code-bg': 'rgba(0,0,0,0.06)',
    '--code-bg': '#f6f8fa',
    '--code-text': '#2c2c2c',
    '--code-border': '#e6e6e6',
    '--border-color': '#e6e6e6',
  } as CSSProperties,
}

// MarkdownWysiwygEditor - 文件编辑器的所见即所得(WYSIWYG)编辑模式 (类似有道云笔记).
// Tiptap (ProseMirror) 内核 + tiptap-markdown 双向序列化, markdown 是数据真相:
//   - value 与 setContent 均以 markdown 字符串收发 (tiptap-markdown 解析, 而非 HTML).
//   - 粘贴富文本(渲染后内容): ProseMirror 原生解析 HTML → 节点 → 序列化为 markdown.
//   - 粘贴纯文本 markdown: transformPastedText:true 自动按 markdown 解析.
//   - onUpdate 把最新 markdown 推回父组件, 复用现有 doc/dirty/save 链路, 保存逻辑无需改.
// 配色跟随代码区 skin, 复用全局 .prose-chat 排版; Tiptap/任务列表的补充样式见 index.css .cc-wysiwyg.
export function MarkdownWysiwygEditor({ value, skin, onChange }: Props) {
  // 防回环: 记录编辑器最近一次上报的 markdown. 父组件据此 value 回灌时,
  // 若与之一致则跳过 setContent, 避免每次按键都重置文档 (丢光标/历史).
  const lastReportedRef = useRef<string>(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    extensions: [
      StarterKit,            // 标题/段落/加粗/斜体/删除线/行内代码/代码块/有序无序列表/引用/分割线/撤销重做
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),   // GFM 任务列表
      Markdown.configure({
        html: true,                 // 保留粘贴富文本里的内联 HTML
        breaks: false,              // 单换行不转 <br> (markdown 惯例, 避免无意断行)
        linkify: true,              // 自动识别裸 URL 为链接
        transformPastedText: true,  // ★ 粘贴纯文本按 markdown 解析 (用户核心诉求)
        transformCopiedText: false, // 复制仍输出富文本 (方便粘到其他富文本编辑器)
      }),
    ],
    content: value,         // tiptap-markdown: 初始内容按 markdown 解析
    autofocus: false,
    onUpdate: ({ editor }) => {
      const md = editor.storage.markdown.getMarkdown()
      lastReportedRef.current = md
      onChangeRef.current(md)
    },
    editorProps: {
      attributes: { class: 'prose-chat cc-wysiwyg-editor', spellcheck: 'false' },
    },
  })

  // 外部 value 变化 (切换文件 / 撤销回磁盘态 / 父组件重置) 时同步进编辑器.
  // 仅当与编辑器最近上报的 markdown 不一致才 setContent, 否则会回环 (每次按键都重置).
  useEffect(() => {
    if (!editor) return
    if (lastReportedRef.current === value) return
    lastReportedRef.current = value
    editor.commands.setContent(value, false)   // false: 不发射 onUpdate, 不进 history
  }, [value, editor])

  return (
    <div
      className="cc-wysiwyg h-full overflow-y-auto"
      style={{ ...WYSIWYG_VARS[skin], padding: '20px 28px 40px' }}
    >
      <EditorContent editor={editor} />
    </div>
  )
}
