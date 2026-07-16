import { Loader2 } from 'lucide-react'

// 列表加载占位: 切换项目拉取 issue/research 列表期间, 用来替代"暂无 XX"空态,
// 避免用户误以为新项目没有数据. 视觉与 knowledge-editor-modal 等处一致 (Loader2 + animate-spin).
export function ListLoadingHint({ text = '加载中...', compact = false }: { text?: string; compact?: boolean } = {}) {
  return (
    <div
      className={`flex items-center justify-center gap-2 ${compact ? 'py-2' : 'py-8'}`}
      style={{ color: 'var(--text-muted)' }}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span className="text-[12px]">{text}</span>
    </div>
  )
}
