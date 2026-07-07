/**
 * viewer/RoundGroups.tsx — 对话轮次分组 / 上文续接分组的容器组件.
 *
 * 从 jsonl-view.tsx 拆出.
 *  - EntryCardWithImages: 在普通 entry 卡片后追加 display_images / 附件图片派生的图像卡片.
 *  - ContinuationGroup: "上文续接"折叠组 (尾部窗口截掉的头部条目); 只有一组时强制展开.
 *  - RoundGroup: 一个对话轮次 (1 条 user 问题 + N 条 agent 回复); 最新轮默认展开,
 *    上一轮在下一轮出现时自动折叠, 用户手动操作过的轮尊重用户.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import type { AnyEntry, BashToolResult, JsonlViewItem, Round } from './types'
import { entryDisplayImages, entryUserAttachmentImages } from './entry-extract'
import { buildHeaderSummary } from './header-summary'
import { JsonEntryCard } from './EntryCard'
import { DisplayImagesCard } from './DisplayImages'

export function EntryCardWithImages({ entry, lineNo, bashResults = [], readResults = [], defaultExpanded = false, showMeta = true }: {
  entry: AnyEntry
  lineNo: number
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
  defaultExpanded?: boolean
  showMeta?: boolean
}) {
  const displayImages = entryDisplayImages(entry)
  const attachmentImages = entryUserAttachmentImages(entry)
  const imgs = Array.from(new Set([...displayImages, ...attachmentImages]))
  const sourceLabel = displayImages.length > 0 && attachmentImages.length > 0
    ? 'display_images / 附件图片'
    : attachmentImages.length > 0
      ? '附件图片'
      : 'display_images'
  return (
    <>
      <JsonEntryCard entry={entry} lineNo={lineNo} defaultExpanded={defaultExpanded} showMeta={showMeta} bashResults={bashResults} readResults={readResults} />
      {imgs.length > 0 && <DisplayImagesCard images={imgs} lineNo={lineNo} sourceLabel={sourceLabel} />}
    </>
  )
}

export function ContinuationGroup({ items, onlyGroup, showMeta = true }: { items: JsonlViewItem[]; onlyGroup: boolean; showMeta?: boolean }) {
  // 只有一组时强制展开, 禁止折叠; 其它场景保留原默认折叠行为
  const [open, setOpen] = useState(onlyGroup)
  useEffect(() => { if (onlyGroup) setOpen(true) }, [onlyGroup])
  const firstSummary = items[0] ? buildHeaderSummary(items[0].entry).short : ''

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onlyGroup ? undefined : () => setOpen(o => !o)}
        disabled={onlyGroup}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl border border-amber-500/15 transition-colors text-left group ${onlyGroup ? 'cursor-default' : 'hover:bg-[var(--bg-card-hover)] hover:border-amber-500/30'}`}
      >
        <span className="font-mono text-[10px] font-bold text-amber-400/75 flex-shrink-0 w-8">
          ...
        </span>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
        <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0">
          上文续接{firstSummary ? ` · ${firstSummary}` : ''}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 font-mono">
          +{items.length}
        </span>
        {!onlyGroup && (
          <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
            {open ? '▲' : '▼'}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2">
          {items.map(({ entry, lineNo, bashResults, readResults }) => (
            <div key={(entry?.uuid || entry?.id || entry?.timestamp || '') + '#' + lineNo} className="flex items-start gap-1.5">
              <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-7 text-right leading-none select-none">
                ...
              </span>
              <div className="flex-1 min-w-0">
                <EntryCardWithImages entry={entry} lineNo={lineNo} bashResults={bashResults} readResults={readResults} showMeta={showMeta} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function RoundGroup({ round, isLast, onlyGroup, showMeta = true }: { round: Round; isLast: boolean; onlyGroup: boolean; showMeta?: boolean }) {
  // 追踪用户是否手动点击过折叠/展开. 一旦手动操作, 后续不再被 isLast 自动接管.
  // 实现"最后一个 group 自动展开, 除非人为折叠": 最新轮默认展开, 其余默认折叠;
  // 某轮从非最新升为最新时自动展开; 用户手动操作过的轮尊重用户, 不再自动改.
  const userToggledRef = useRef(false)
  const [open, setOpen] = useState(isLast || onlyGroup)

  // onlyGroup 时永远保持展开; 否则跟随 isLast 自动展开/折叠, 但用户手动操作过则尊重用户.
  useEffect(() => {
    if (onlyGroup) { setOpen(true); return }
    if (userToggledRef.current) return
    setOpen(isLast)
  }, [isLast, onlyGroup])

  const toggle = () => {
    userToggledRef.current = true
    setOpen(o => !o)
  }

  const userItem = round.items[0]
  const agentCount = round.items.length - 1
  const userSummary = userItem ? buildHeaderSummary(userItem.entry).short : ''

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onlyGroup ? undefined : toggle}
        disabled={onlyGroup}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-slate-500/15 transition-colors text-left group ${onlyGroup ? 'cursor-default' : 'hover:bg-[var(--bg-card-hover)] hover:border-slate-500/30'}`}
      >
        {/* <span className="font-mono text-[10px] font-bold text-blue-400/70 flex-shrink-0 w-4">
          {round.roundNum}
        </span> */}
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 flex-shrink-0" />
        <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0">
          {userSummary || '(空)'}
        </span>
        {!open && agentCount > 0 && (
          <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 font-mono">
            +{agentCount}
          </span>
        )}
        {!onlyGroup && (
          <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
            {open ? '▲' : '▼'}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2 jsonl-thread">
          {round.items.map((item, idx) => {
            const isUserItem = item.relIdx === 0
            const isLastEntry = isLast && idx === round.items.length - 1
            return (
              <Fragment key={(item.entry?.uuid || '') + '#' + item.lineNo}>
                <div className="flex items-start gap-1.5">
                  <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-5 text-right leading-none select-none">
                    {/* 用户问题已在 header 显示 1.0，展开内容里不重复打标签 */}
                    {isUserItem ? 'u' : `${item.relIdx}`}
                  </span>
                  <div className="flex-1 min-w-0">
                    <EntryCardWithImages
                      entry={item.entry}
                      lineNo={item.lineNo}
                      bashResults={item.bashResults}
                      readResults={item.readResults}
                      showMeta={showMeta}
                    />
                  </div>
                </div>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
