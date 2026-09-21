// 会话/项目表单用的纯函数: 随机项目绑定路径 + 默认会话名.
//
// 单独成一个模块是有意为之: 简易模式首屏和欢迎页配置条都要用这两个函数, 若它们留在
// components/modals.tsx 里, 就会把整个弹窗模块(含 react-markdown 渲染栈)拖进首屏依赖闭包,
// 打开简易模式等于先下载一堆弹窗代码.
//
// These pure helpers live on their own on purpose: the easy-mode landing screen and the
// welcome config bar both need them, and keeping them inside components/modals.tsx would
// drag the whole modal module into the first-paint dependency closure.

const RANDOM_PROJECT_ADJECTIVES = [
  'bright', 'calm', 'clever', 'cozy', 'cute', 'eager', 'fresh', 'gentle',
  'happy', 'kind', 'lively', 'lovely', 'lucky', 'merry', 'neat', 'nimble',
  'quiet', 'rapid', 'smart', 'sunny', 'tidy', 'warm', 'wise', 'young',
]
const RANDOM_PROJECT_NOUNS = [
  'bird', 'brook', 'cloud', 'field', 'forest', 'garden', 'harbor', 'lake',
  'leaf', 'light', 'meadow', 'moon', 'mountain', 'river', 'seed', 'snake',
  'spark', 'star', 'stone', 'sun', 'tree', 'valley', 'wave', 'wind',
]

function randomProjectWord(words: string[]) {
  return words[Math.floor(Math.random() * words.length)] || words[0]
}

/** 随机项目标识: adjective_noun (字符仅字母与下划线, 符合 identifier 规则) */
export function randomProjectSlug() {
  return `${randomProjectWord(RANDOM_PROJECT_ADJECTIVES)}_${randomProjectWord(RANDOM_PROJECT_NOUNS)}`
}

/** 在工作目录下生成一个随机绑定路径; 没有工作目录时返回空串 */
export function randomProjectBindPath(workDir?: string | null) {
  const root = (workDir || '').trim().replace(/\/+$/, '')
  if (!root) return ''
  return `${root || '/'}/${randomProjectSlug()}`.replace(/\/{2,}/g, '/')
}

// 默认会话名 = 可选所属标题 + 当前时间（YYYY-MM-DD HH:mm）
function formatNowForName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 默认会话名: 标题存在时拼上时间戳, 否则只有时间戳 */
export function formatDefaultSessionName(scopeTitle?: string): string {
  const time = formatNowForName()
  const title = (scopeTitle || '').replace(/\s+/g, ' ').trim()
  return title ? `${title} ${time}` : time
}
