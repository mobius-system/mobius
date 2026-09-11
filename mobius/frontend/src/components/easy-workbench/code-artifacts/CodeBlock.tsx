import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import { FileReferenceLink } from './FileReferenceLink'
import type { CodeArtifactTarget } from './file-target'

type CopySource = string | (() => string)

const PATH_LANGUAGE: Record<string, string> = {
  adoc: 'markdown', asm: 'x86asm', awk: 'awk', bash: 'shell', bat: 'dos', c: 'c',
  cc: 'cpp', cjs: 'javascript', cmake: 'cmake', cmd: 'dos', coffee: 'coffeescript',
  conf: 'ini', cpp: 'cpp', cs: 'csharp', css: 'css', csv: 'csv', cts: 'typescript',
  cxx: 'cpp', dart: 'dart', diff: 'diff', dockerfile: 'dockerfile', elm: 'elm',
  env: 'ini', erl: 'erlang', ex: 'elixir', exs: 'elixir', f90: 'fortran',
  f95: 'fortran', fs: 'fsharp', go: 'go', gradle: 'gradle', graphql: 'graphql',
  groovy: 'groovy', gql: 'graphql', h: 'c', hbs: 'handlebars', hpp: 'cpp',
  hs: 'haskell', htm: 'html', html: 'html', http: 'http', ini: 'ini',
  java: 'java', jl: 'julia', js: 'javascript', json: 'json', json5: 'json',
  jsonc: 'json', jsonl: 'jsonl', jsx: 'jsx', kt: 'kotlin', kts: 'kotlin',
  less: 'less', ll: 'llvm', log: 'log', lua: 'lua', m: 'objectivec',
  mak: 'makefile', markdown: 'markdown', matlab: 'matlab', md: 'markdown',
  mdx: 'mdx', mjs: 'javascript', mk: 'makefile', mm: 'objectivec',
  mts: 'typescript', nginx: 'nginx', nim: 'nim', objc: 'objectivec',
  patch: 'diff', php: 'php', pl: 'perl', pm: 'perl', properties: 'properties',
  proto: 'protobuf', ps1: 'powershell', psm1: 'powershell', py: 'python',
  r: 'r', rb: 'ruby', rs: 'rust', s: 'x86asm', scala: 'scala', scss: 'scss',
  sh: 'shell', sql: 'sql', styl: 'stylus', svg: 'xml', swift: 'swift',
  t: 'perl', tex: 'latex', toml: 'toml', ts: 'typescript', tsx: 'tsx',
  txt: 'text', vb: 'vbnet', vim: 'vim', vue: 'vue', wasm: 'wasm',
  xhtml: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'shell',
}

const BASENAME_LANGUAGE: Record<string, string> = {
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.dockerignore': 'text',
  '.editorconfig': 'ini',
  '.env': 'ini',
  '.env.example': 'ini',
  '.env.local': 'ini',
  '.gitconfig': 'ini',
  '.gitignore': 'text',
  '.npmrc': 'ini',
  '.zshrc': 'shell',
  'cmakelists.txt': 'cmake',
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  gnumakefile: 'makefile',
  jenkinsfile: 'groovy',
  makefile: 'makefile',
  'nginx.conf': 'nginx',
  procfile: 'text',
  rakefile: 'ruby',
  vagrantfile: 'ruby',
}

export function normalizeCodeLanguage(value?: string | null) {
  const language = String(value || '').trim().toLocaleLowerCase()
  return language || 'text'
}

export function codeLanguageFromClassName(className?: string | null) {
  const match = String(className || '').match(/(?:^|\s)language-([^\s]+)/i)
  return normalizeCodeLanguage(match?.[1])
}

export function codeLanguageFromPath(path?: string | null) {
  const cleanPath = String(path || '').split(/[?#]/, 1)[0]
  const basename = (cleanPath.split(/[\\/]/).pop() || '').toLocaleLowerCase()
  if (BASENAME_LANGUAGE[basename]) return BASENAME_LANGUAGE[basename]
  const extension = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : basename
  return PATH_LANGUAGE[extension] || 'text'
}

export async function copyCodeText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      document.body.removeChild(textarea)
    }
  }
}

export function CodeBlockHeader({
  language,
  target,
  copySource,
  copyLabel = '复制代码',
  children,
  className = '',
}: {
  language?: string | null
  target?: CodeArtifactTarget | null
  copySource?: CopySource
  copyLabel?: string
  children?: ReactNode
  className?: string
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const resetTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
  }, [])

  const copy = useCallback(async () => {
    const value = typeof copySource === 'function' ? copySource() : copySource
    if (value === undefined) return
    const copied = await copyCodeText(value)
    setCopyState(copied ? 'copied' : 'error')
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600)
  }, [copySource])

  const copyTitle = copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败，请手动选择' : copyLabel

  return (
    <div className={`code-block-header ${className}`.trim()} data-code-target={target ? 'present' : 'absent'}>
      <span className="code-block-header__language" data-code-language={normalizeCodeLanguage(language)}>
        {normalizeCodeLanguage(language)}
      </span>
      {target && <FileReferenceLink target={target} className="code-block-header__file" />}
      <div className="code-block-header__status">{children}</div>
      {copySource !== undefined && (
        <button
          type="button"
          className={`code-block-header__copy code-block-header__copy--${copyState}`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void copy()
          }}
          aria-label={copyTitle}
          title={copyTitle}
        >
          {copyState === 'copied'
            ? <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            : copyState === 'error'
              ? <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              : <Copy className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden="true" />}
          <span>{copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制'}</span>
        </button>
      )}
    </div>
  )
}

function codeChild(children: ReactNode) {
  return Children.toArray(children).find((child): child is ReactElement<{ className?: string }> => (
    isValidElement(child)
  ))
}

export function MarkdownCodeBlock({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement>(null)
  const child = codeChild(children)
  const language = codeLanguageFromClassName(child?.props.className)

  return (
    <div className="prose-pre-wrap code-block">
      <CodeBlockHeader language={language} copySource={() => preRef.current?.textContent || ''} />
      <pre ref={preRef} {...props}>
        {children}
      </pre>
    </div>
  )
}
