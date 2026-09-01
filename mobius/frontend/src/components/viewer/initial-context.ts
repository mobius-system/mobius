/**
 * viewer/initial-context.ts — 初始消息辨识与分块解析 (纯逻辑, 无 React 依赖).
 *
 * 首轮用户消息会被后端 session-context.ts 包装成 「引导语 + 各上下文段 + --- + 用户的问题」
 * 的大字符串 (动辄上万字符)。本模块辨识这种消息 (中英双语自适应), 并按
 * backend/services/session-context-sections.ts 的同一份块目录做「有序锚点扫描」切块,
 * 供初始卡片 (InitialCard) 分块渲染。
 *
 * 扫描规则 (与生成侧拼装顺序严格对应):
 *  - 块边界只认目录内标题 (整行强匹配), 且只在「顺序位于当前块之后、尚未消费」的标题里找;
 *    memory 正文等用户内容里的 `## 标题` 不会误切 (顺序约束 + 目录约束双保险)。
 *  - 用户的问题标题用最后一次命中 (wrapUserMessage 在正文拼完后追加, 真锚点必为最后)。
 */
import type { AnyEntry } from './types'
import {
  SESSION_SECTIONS,
  QuestionTitle,
  HeaderSection,
  type SectionDef,
} from '../../../../backend/services/session-context-sections'

export type InitialContextBlock = {
  // 块目录 key ('user' | 'memory' | ...); 不在目录里的内容归入前一块, 故无 unknown
  key: string
  // 原始标题行 (如 '## 用户'); header 段为引导语本身
  title: string
  // 段正文 (不含标题行, 首尾空行已剥)
  body: string
  // 标题行之后的正文行数 (供 UI 折叠态展示量级)
  lineCount: number
}

export type InitialContextMatch = {
  language: 'zh' | 'en'
  // header 段引导语 (标题行之前/以外的开头文本, 如 💧 前缀行也归这里)
  intro: string
  blocks: InitialContextBlock[]
  // 用户问题正文 (wrapUserMessage 的 ## 用户的问题 之后全部; 无包装时为空)
  question: string
  // 原始完整文本
  raw: string
}

// user 角色消息的可见文本 (覆盖 claude type:user 与 codex response_item 两种形态)。
function entryUserText(entry: AnyEntry): string {
  if (entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user') {
    const c = entry?.payload?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? b?.input_text ?? ''))).filter(Boolean).join('\n')
    return ''
  }
  if (entry?.type === 'user') {
    const c = entry?.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? ''))).filter(Boolean).join('\n')
    return ''
  }
  return ''
}

// 前置快筛: buildHeaderSummary 每卡都会调, 这里必须廉价 (纯 includes, 命中才做完整解析)。
// 双重门槛排除误命中 (用户在问题里原样引用引导语文案的裸输入卡):
//  ① 引导语出现在开头 400 字符内; ② 正文命中 ≥2 个目录锚点行 (整行强匹配, 包装消息必有)。
function detectLanguage(text: string): 'zh' | 'en' | null {
  const head = text.slice(0, 400)
  const lang = head.includes(HeaderSection.title.zh) ? 'zh' : head.includes(HeaderSection.title.en) ? 'en' : null
  if (!lang) return null
  const hitKeys = new Set<string>()
  for (const line of text.split('\n')) {
    for (const section of SECTION_ANCHOR_SECTIONS) {
      if (!hitKeys.has(section.key) && section.pattern[lang].test(line)) {
        hitKeys.add(section.key)
        if (hitKeys.size >= 2) return lang
      }
    }
  }
  return null
}

// wrapUserMessage 固定形态: `${body}\n\n---\n\n${heading}\n${question}`。
// 取最后一次命中 (正文拼完后才追加真锚点); 问题内部再出现同标题也不会被误切到更早位置。
function splitQuestion(text: string, lang: 'zh' | 'en'): { contextPart: string; question: string } {
  const heading = QuestionTitle[lang]
  const marker = `\n${heading}\n`
  const idx = text.lastIndexOf(marker)
  if (idx < 0) return { contextPart: text, question: '' }
  let contextPart = text.slice(0, idx)
  const question = text.slice(idx + marker.length)
  // 剥掉 wrap 的 '---' 分隔行 (contextPart 尾部的 '\n\n---\n\n'; 只剥最末一个)
  const trimmed = contextPart.replace(/\s+$/, '')
  if (/(^|\n)---$/.test(trimmed)) contextPart = trimmed.slice(0, trimmed.length - 3).replace(/\s+$/, '')
  else contextPart = trimmed
  return { contextPart, question }
}

const SECTION_ORDER_INDEX: Map<string, number> = new Map(SESSION_SECTIONS.map((s, i) => [s.key, i]))

// 快筛用的锚点候选: 排除 header 自身 (它是引导语不是锚点行)。
const SECTION_ANCHOR_SECTIONS: SectionDef[] = SESSION_SECTIONS.filter((s) => s.key !== 'header')

// 有序锚点扫描: 逐行判边界, 边界只在「顺序位于当前块之后」的目录标题里整行强匹配。
function parseBlocks(body: string, lang: 'zh' | 'en'): { intro: string; blocks: InitialContextBlock[] } {
  const lines = body.split('\n')
  const introLines: string[] = []
  let current: { def: SectionDef; title: string; lines: string[] } | null = null
  const blocks: InitialContextBlock[] = []
  const minPos = SECTION_ORDER_INDEX.get('header')! // header 之后才可能出现锚点

  const closeCurrent = () => {
    if (!current) return
    blocks.push({
      key: current.def.key,
      title: current.title,
      body: current.lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
      lineCount: current.lines.filter((l) => l.trim() !== '').length,
    })
    current = null
  }

  for (const line of lines) {
    const fromPos: number = current ? (SECTION_ORDER_INDEX.get(current.def.key)! + 1) : (minPos + 1)
    let matched: SectionDef | null = null
    for (let p: number = fromPos; p < SESSION_SECTIONS.length && !matched; p += 1) {
      if (SESSION_SECTIONS[p].pattern[lang].test(line)) matched = SESSION_SECTIONS[p]
    }
    if (matched) {
      closeCurrent()
      current = { def: matched, title: line, lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      introLines.push(line)
    }
  }
  closeCurrent()
  return { intro: introLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''), blocks }
}

// 辨识 + 解析一条 entry。非初始消息 (或文本形态不符) 返回 null, 调用方回退普通用户卡。
// mobius 边车的裸输入卡 (未经 context 包装的原文) 直接跳过 —— 即使原文里引用了引导语文案。
export function extractInitialContext(entry: AnyEntry): InitialContextMatch | null {
  if (entry?.entrypoint === 'mobius' || entry?.mobius?.kind === 'user_input') return null
  const text = entryUserText(entry)
  if (!text) return null
  const lang = detectLanguage(text)
  if (!lang) return null
  const { contextPart, question } = splitQuestion(text, lang)
  const { intro, blocks } = parseBlocks(contextPart, lang)
  return { language: lang, intro, blocks, question, raw: text }
}

// 摘要辅助: 初始消息的一行摘要 = 「初始 · 问题首行」 (无问题时回落引导语)。
export function initialContextSummaryLine(match: InitialContextMatch): string {
  const firstLine = match.question.trim().split('\n').map((l) => l.trim()).find((l) => l) || ''
  if (firstLine) return `初始 · ${firstLine}`
  const introLine = match.intro.trim().split('\n')[0] || ''
  return introLine ? `初始 · ${introLine}` : '初始上下文'
}
