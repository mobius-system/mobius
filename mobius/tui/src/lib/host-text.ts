/**
 * Terminal-host quirks for classic Windows consoles.
 *
 * conhost (the native cmd window) renders East Asian ambiguous characters
 * (·, ›, …, ●, ○) as two cells when the console font is a CJK font, while Ink's
 * layout (string-width) counts them as one. Right-aligned rows therefore spill
 * their last cells onto the next line, and resizing the window does not help
 * because the mismatch depends on the glyphs, not the width. Windows Terminal
 * renders the same characters as one cell, so only classic conhost needs the
 * ASCII fallbacks below.
 */
export const IS_CONHOST = process.platform === 'win32'
  && !process.env.WT_SESSION
  && process.env.TERM_PROGRAM !== 'vscode'

const ASCII_FALLBACK: Record<string, string> = {
  '·': '-', // middle dot used in status separators
  '›': '>', // breadcrumb separator
  '…': '...', // ellipsis
  '●': '*', // filled status dot
  '○': 'o', // hollow status dot
  '◐': '~', // partial status dot
  '◇': '<>', // reasoning marker
  '✎': '*', // edit marker
  '⚠': '!', // warning marker
  '•': '*', // bullet
}

/** Replace wide-rendered ambiguous glyphs when running inside classic conhost. */
export function hostText(value: string): string {
  if (!IS_CONHOST) return value
  let out = ''
  for (const ch of Array.from(value)) out += ASCII_FALLBACK[ch] ?? ch
  return out
}
