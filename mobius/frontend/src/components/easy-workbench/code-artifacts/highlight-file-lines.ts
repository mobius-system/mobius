import hljs from 'highlight.js/lib/common'
import awk from 'highlight.js/lib/languages/awk'
import cmake from 'highlight.js/lib/languages/cmake'
import coffeescript from 'highlight.js/lib/languages/coffeescript'
import clojure from 'highlight.js/lib/languages/clojure'
import dart from 'highlight.js/lib/languages/dart'
import django from 'highlight.js/lib/languages/django'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import dos from 'highlight.js/lib/languages/dos'
import elixir from 'highlight.js/lib/languages/elixir'
import elm from 'highlight.js/lib/languages/elm'
import erlang from 'highlight.js/lib/languages/erlang'
import fortran from 'highlight.js/lib/languages/fortran'
import fsharp from 'highlight.js/lib/languages/fsharp'
import gradle from 'highlight.js/lib/languages/gradle'
import groovy from 'highlight.js/lib/languages/groovy'
import handlebars from 'highlight.js/lib/languages/handlebars'
import haskell from 'highlight.js/lib/languages/haskell'
import http from 'highlight.js/lib/languages/http'
import julia from 'highlight.js/lib/languages/julia'
import latex from 'highlight.js/lib/languages/latex'
import llvm from 'highlight.js/lib/languages/llvm'
import matlab from 'highlight.js/lib/languages/matlab'
import nginx from 'highlight.js/lib/languages/nginx'
import nim from 'highlight.js/lib/languages/nim'
import ocaml from 'highlight.js/lib/languages/ocaml'
import powershell from 'highlight.js/lib/languages/powershell'
import properties from 'highlight.js/lib/languages/properties'
import protobuf from 'highlight.js/lib/languages/protobuf'
import scala from 'highlight.js/lib/languages/scala'
import stylus from 'highlight.js/lib/languages/stylus'
import vim from 'highlight.js/lib/languages/vim'
import x86asm from 'highlight.js/lib/languages/x86asm'

/** common 未收录、但仓库里经常出现的语言。 */
const EXTRA_LANGUAGES = {
  awk,
  cmake,
  clojure,
  coffeescript,
  dart,
  django,
  dockerfile,
  dos,
  elixir,
  elm,
  erlang,
  fortran,
  fsharp,
  gradle,
  groovy,
  handlebars,
  haskell,
  http,
  julia,
  latex,
  llvm,
  matlab,
  nginx,
  nim,
  ocaml,
  powershell,
  properties,
  protobuf,
  scala,
  stylus,
  vim,
  x86asm,
}

/** 我们的语言名 → highlight.js 注册名。未列出的只要 hljs 已注册就原样使用。 */
const LANGUAGE_ALIASES: Record<string, string> = {
  adoc: 'asciidoc',
  bash: 'bash',
  bat: 'dos',
  batch: 'dos',
  c: 'c',
  cc: 'cpp',
  cmake: 'cmake',
  cmd: 'dos',
  coffee: 'coffeescript',
  coffeescript: 'coffeescript',
  console: 'shell',
  cpp: 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  dart: 'dart',
  diff: 'diff',
  django: 'django',
  docker: 'dockerfile',
  dockerfile: 'dockerfile',
  dos: 'dos',
  elixir: 'elixir',
  elm: 'elm',
  env: 'ini',
  erlang: 'erlang',
  ex: 'elixir',
  fortran: 'fortran',
  fs: 'fsharp',
  fsharp: 'fsharp',
  go: 'go',
  golang: 'go',
  gradle: 'gradle',
  graphql: 'graphql',
  groovy: 'groovy',
  h: 'c',
  handlebars: 'handlebars',
  haskell: 'haskell',
  hbs: 'handlebars',
  hpp: 'cpp',
  hs: 'haskell',
  htm: 'xml',
  html: 'xml',
  http: 'http',
  ini: 'ini',
  java: 'java',
  javascript: 'javascript',
  jinja: 'django',
  js: 'javascript',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  jsonl: 'json',
  jsx: 'javascript',
  julia: 'julia',
  kt: 'kotlin',
  kotlin: 'kotlin',
  kts: 'kotlin',
  latex: 'latex',
  less: 'less',
  llvm: 'llvm',
  log: 'plaintext',
  lua: 'lua',
  make: 'makefile',
  makefile: 'makefile',
  markdown: 'markdown',
  matlab: 'matlab',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mk: 'makefile',
  mm: 'objectivec',
  mts: 'typescript',
  nginx: 'nginx',
  nim: 'nim',
  objc: 'objectivec',
  objectivec: 'objectivec',
  ocaml: 'ocaml',
  patch: 'diff',
  perl: 'perl',
  php: 'php',
  pl: 'perl',
  plaintext: 'plaintext',
  powershell: 'powershell',
  properties: 'properties',
  proto: 'protobuf',
  protobuf: 'protobuf',
  ps1: 'powershell',
  py: 'python',
  python: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  ruby: 'ruby',
  rust: 'rust',
  scala: 'scala',
  scss: 'scss',
  sh: 'bash',
  shell: 'bash',
  sql: 'sql',
  styl: 'stylus',
  stylus: 'stylus',
  svg: 'xml',
  swift: 'swift',
  tex: 'latex',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  vb: 'vbnet',
  vbnet: 'vbnet',
  vim: 'vim',
  vue: 'xml',
  wasm: 'wasm',
  xhtml: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

const PLAIN_LANGUAGES = new Set(['', 'text', 'txt', 'csv'])

let extrasRegistered = false

function registerExtraLanguages() {
  if (extrasRegistered) return
  for (const [name, language] of Object.entries(EXTRA_LANGUAGES)) {
    if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language)
  }
  extrasRegistered = true
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function highlightLanguageId(language?: string | null) {
  const raw = String(language || '').trim().toLowerCase()
  if (PLAIN_LANGUAGES.has(raw)) return ''
  registerExtraLanguages()
  const mapped = LANGUAGE_ALIASES[raw] || raw
  return hljs.getLanguage(mapped) ? mapped : ''
}

/** 把整文件高亮 HTML 按换行拆开，并在行边界闭合/重开 span，避免跨行标签把后面的行染错。 */
export function splitHighlightedHtml(html: string) {
  const lines: string[] = []
  let current = ''
  const openTags: string[] = []
  const tokens = html.match(/<\/?span\b[^>]*>|\n|[^<\n]+/g) || []
  for (const token of tokens) {
    if (token === '\n') {
      current += '</span>'.repeat(openTags.length)
      lines.push(current)
      current = openTags.join('')
      continue
    }
    if (token.startsWith('</')) {
      openTags.pop()
      current += token
      continue
    }
    if (token.startsWith('<')) {
      openTags.push(token)
      current += token
      continue
    }
    current += token
  }
  lines.push(current)
  return lines
}

export function highlightFileLines(content: string, language?: string | null) {
  const source = content ?? ''
  const languageId = highlightLanguageId(language)
  if (!languageId) return source.split('\n').map(line => escapeHtml(line) || ' ')
  try {
    const html = hljs.highlight(source, { language: languageId, ignoreIllegals: true }).value
    return splitHighlightedHtml(html).map(line => line || ' ')
  } catch {
    return source.split('\n').map(line => escapeHtml(line) || ' ')
  }
}
