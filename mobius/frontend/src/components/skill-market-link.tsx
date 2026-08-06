import { ExternalLink } from 'lucide-react'

const SKILL_MARKET_URL = 'https://skillsmp.com/'

export function SkillMarketLink({ className = '' }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.open(SKILL_MARKET_URL, '_blank', 'noopener,noreferrer')}
      className={`inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/30 px-2.5 py-1 text-[11px] text-emerald-500 transition-colors hover:bg-emerald-500/10 ${className}`}
      title="在新窗口打开 Skill 市场"
      aria-label="在新窗口打开 Skill 市场"
    >
      <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
      Skill 市场
    </button>
  )
}
