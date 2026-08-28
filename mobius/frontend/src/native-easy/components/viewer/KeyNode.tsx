/**
 * viewer/KeyNode.tsx — JSON 树递归渲染节点 (单个 key:value).
 *
 * 从 jsonl-view.tsx 拆出. primitive 一行紧凑; 多行字符串 / object / array 用 <details>
 * 折叠, 默认展开/折叠由 EXPAND_KEYS / COLLAPSE_KEYS 决定 (内容向 key 展开, 元数据折叠).
 */
import { isPrimitive, previewPrimitive, summarize } from './utils'

// 默认展开的 key (内容向, 用户关心)
const EXPAND_KEYS = new Set([
  'type', 'message', 'attachment', 'lastPrompt', 'toolUseResult', 'operation',
  'content', 'role',
  'text', 'thinking', 'name', 'input',
  'result', 'stdout', 'stderr', 'output',
  'hookInfos', 'hookCount', 'subtype',
])

// 默认折叠的 key (元数据 / 噪音, 用户基本不看)
const COLLAPSE_KEYS = new Set([
  'uuid', 'parentUuid', 'sessionId', 'requestId', 'promptId', 'messageId', 'id',
  'version', 'gitBranch', 'cwd', 'entrypoint', 'userType', 'isSidechain',
  'timestamp', 'usage', 'signature', 'stop_details', 'stop_reason',
  'model', 'snapshot', 'caller', 'sourceToolAssistantUUID',
])

// 单个 key:value 节点. 递归.
export function KeyNode({ k, v, depth, parentKey }: { k: string; v: any; depth: number; parentKey?: string }) {
  // primitive: 一行紧凑
  if (isPrimitive(v)) {
    // 多行字符串: 也用 details 折叠
    if (typeof v === 'string' && v.includes('\n') && v.length > 80) {
      const defaultOpen = EXPAND_KEYS.has(k)
      return (
        <details open={defaultOpen} className="ml-3 my-0.5">
          <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] select-text">
            <span className="text-amber-300/80 font-mono">{k}</span>
            <span className="text-gray-500"> : </span>
            <span className="italic">"…" ({v.split('\n').length} lines)</span>
          </summary>
          <pre className="mt-1 ml-3 px-2 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-words rounded border border-[var(--border-color)] bg-[var(--prose-bg)] text-[var(--text-secondary)] max-h-96 overflow-auto">{v}</pre>
        </details>
      )
    }
    return (
      <div className="ml-3 my-0.5 text-[11px] font-mono leading-snug">
        <span className="text-amber-300/80">{k}</span>
        <span className="text-gray-500"> : </span>
        <span className={typeof v === 'string' ? 'text-emerald-300/90 break-words' : 'text-cyan-300/90'}>
          {previewPrimitive(v)}
        </span>
      </div>
    )
  }

  // container (object / array)
  const defaultOpen = depth === 0 ? true : (EXPAND_KEYS.has(k) && !COLLAPSE_KEYS.has(k))
  return (
    <details open={defaultOpen} className="ml-3 my-0.5 group">
      <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] select-text font-mono">
        <span className="text-amber-300/80">{k}</span>
        <span className="text-gray-500"> : </span>
        <span className="text-violet-300/70">{summarize(v, k)}</span>
      </summary>
      <div className="ml-1 jsonl-thread">
        {Array.isArray(v)
          ? v.map((item, i) => <KeyNode key={i} k={String(i)} v={item} depth={depth + 1} parentKey={k} />)
          : Object.entries(v).map(([ck, cv]) => <KeyNode key={ck} k={ck} v={cv} depth={depth + 1} parentKey={k} />)
        }
      </div>
    </details>
  )
}
