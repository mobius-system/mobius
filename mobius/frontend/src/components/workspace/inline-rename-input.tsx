// InlineRenameInput — 节点内联重命名输入框 (替代 window.prompt, 设计文档 §5.7, §11.3)。
// 行为: 打开自动聚焦 + 选中文件名主体; Enter 提交; Esc/失焦取消 (不自动提交); 提交中禁用;
// 失败保留用户输入 (组件不卸载) + 红框 + title 错误, 详细错误由宿主 Toast 展示。
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { selectRenameRange } from './file-tree-ops'

type Props = {
  defaultName: string
  submitting?: boolean
  error?: string
  onSubmit: (newName: string) => void
  onCancel: () => void
}

export function InlineRenameInput({ defaultName, submitting, error, onSubmit, onCancel }: Props) {
  const ref = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState(defaultName)
  // 用 ref 镜像 submitting: 提交中会 disable 输入框, 进而触发 blur;
  // 此时若用 prop 判断会被渲染时序坑 (blur handler 可能拿到旧值) 而误取消提交。
  const submittingRef = useRef(false)
  useEffect(() => { submittingRef.current = !!submitting }, [submitting])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const { start, end } = selectRenameRange(defaultName)
    try {
      el.setSelectionRange(start, end)
    } catch {
      /* 部分浏览器在不可见元素上 setSelectionRange 抛错, 忽略 */
    }
  }, [defaultName])

  return (
    <span
      className="mobius-file-tree__rename-wrap"
      // 阻止点击冒泡到行按钮, 避免触发打开文件/折叠目录。
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <input
        ref={ref}
        aria-label="重命名"
        className={`mobius-file-tree__rename-input${error ? ' mobius-file-tree__rename-input--error' : ''}`}
        value={value}
        disabled={submitting}
        title={error || undefined}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit(value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        onBlur={() => {
          // 提交中 (disabled) 不取消; 否则失焦即取消。
          if (!submittingRef.current) onCancel()
        }}
      />
      {submitting && <Loader2 className="mobius-file-tree__rename-spinner animate-spin" />}
    </span>
  )
}
