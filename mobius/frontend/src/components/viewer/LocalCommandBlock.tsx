/**
 * viewer/LocalCommandBlock.tsx — 本地命令产物的展开内容块.
 *
 * 从 jsonl-view.tsx 拆出. local-command 产物 (compact / goal-set / command-name 等) 展开时
 * 不再把原始 <local-command-*> / <command-*> 标签或控制字符铺成字段 JSON, 而是渲染一块
 * 干净的金色提示 (React 自动转义, 安全).
 */
import type { LocalCommandPart } from './types'

export function JsonEntryLocalCommandBlock({ parts }: { parts: LocalCommandPart[] }) {
  const stdout = parts.find((p) => p.tag === 'local-command-stdout')
  const compact = !!stdout && /^compacted/i.test(stdout.body)
  const goalSet = !!stdout && /^goal\s*set/i.test(stdout.body)
  const icon = compact ? '🗜️' : goalSet ? '🎯' : '⚙️'
  const title = compact ? '已压缩对话 · Compacted'
    : goalSet ? '目标已设置 · Goal Set'
    : '本地命令 · Local Command'
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-amber-300" aria-hidden="true">{icon}</span>
        <span className="font-semibold text-amber-200">{title}</span>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {parts.map((p, i) => (
          <div key={`${p.tag}-${i}`} className="flex min-w-0 gap-2 text-[11px]">
            <span className="flex-shrink-0 font-mono text-amber-300/60">{p.tag}</span>
            <span className="min-w-0 break-words select-text text-amber-100/80">{p.body || '(空)'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
