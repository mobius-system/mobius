export type VoicePlaybackMode = 'selected' | 'all'

export const ASSISTANT_TTS_TEXT_CHUNK_LIMIT = 1000
export const VOICE_RECORDING_MAX_MS = 60_000

export type VoiceInputState = 'idle' | 'recording' | 'transcribing' | 'error'

export type VoiceTranscribeResponse = {
  ok?: boolean
  text?: string
  alternatives?: string[]
  request_id?: string
  provider_log_id?: string
}

export type VoiceCommand = {
  text: string
  start: number
  end: number
}

function decodeVoiceCommandString(raw: string) {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(["'\\])/g, '$1')
}

export function extractVoiceCommands(content: string): VoiceCommand[] {
  const text = String(content || '')
  const commands: VoiceCommand[] = []
  const pattern = /PushVoiceToUser\s*\(\s*(["'])([\s\S]*?)(?<!\\)\1\s*\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const value = decodeVoiceCommandString(match[2] || '').trim()
    commands.push({
      text: value,
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return commands
}

export function stripVoiceCommands(content: string) {
  return String(content || '')
    .replace(/^[ \t]*`{1,3}[ \t]*PushVoiceToUser\s*\(\s*(["'])([\s\S]*?)(?<!\\)\1\s*\)[ \t]*;?[ \t]*`{1,3}[ \t]*$/gm, '')
    .replace(/^[ \t]*PushVoiceToUser\s*\(\s*(["'])([\s\S]*?)(?<!\\)\1\s*\)[ \t]*;?[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function sanitizeFullVoiceText(content: string) {
  return stripVoiceCommands(content)
    .replace(/```[^\n`]*\n?([\s\S]*?)```/g, '\n$1\n')
    .replace(/~~~[^\n~]*\n?([\s\S]*?)~~~/g, '\n$1\n')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~>#|]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function selectedVoiceTextForMessage(content: string) {
  const commands = extractVoiceCommands(content)
  if (commands.length === 0) return ''
  return commands.map(command => command.text).filter(Boolean).join('\n')
}

export function voiceTextForMessage(content: string, mode: VoicePlaybackMode = 'all') {
  if (mode === 'selected') return selectedVoiceTextForMessage(content)
  return sanitizeFullVoiceText(content) || selectedVoiceTextForMessage(content)
}

export function hasVoiceCommand(content: string) {
  return extractVoiceCommands(content).length > 0
}

function splitLongPiece(piece: string, maxChars: number) {
  const chunks: string[] = []
  let cursor = 0
  while (cursor < piece.length) {
    chunks.push(piece.slice(cursor, cursor + maxChars))
    cursor += maxChars
  }
  return chunks
}

function splitByReadableBreaks(text: string, maxChars: number) {
  const pieces: string[] = []
  const breakChars = new Set(['。', '！', '？', '；', ';', '!', '?', '，', ',', '、', '\n'])
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (!breakChars.has(text[i])) continue
    const piece = text.slice(start, i + 1).trim()
    if (piece) pieces.push(...splitLongPiece(piece, maxChars))
    start = i + 1
  }
  const tail = text.slice(start).trim()
  if (tail) pieces.push(...splitLongPiece(tail, maxChars))
  return pieces
}

export function splitVoiceTextForSpeech(text: string, maxChars = ASSISTANT_TTS_TEXT_CHUNK_LIMIT) {
  const limit = Math.max(200, Math.floor(maxChars))
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return []
  const pieces = splitByReadableBreaks(normalized, limit)
  const chunks: string[] = []
  let current = ''

  pieces.forEach(piece => {
    const next = current ? `${current}${piece}` : piece
    if (next.length <= limit) {
      current = next
      return
    }
    if (current) chunks.push(current.trim())
    current = piece.length <= limit ? piece : ''
    if (!current && piece) chunks.push(...splitLongPiece(piece, limit).map(item => item.trim()).filter(Boolean))
  })

  if (current) chunks.push(current.trim())
  return chunks.filter(Boolean)
}

export function formatVoiceSeconds(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds))
  const mm = String(Math.floor(safe / 60)).padStart(2, '0')
  const ss = String(safe % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function supportedVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ].find(type => MediaRecorder.isTypeSupported(type)) || ''
}

export function recordingFileExtension(mimeType: string) {
  const lower = mimeType.toLowerCase()
  if (lower.includes('ogg')) return 'ogg'
  if (lower.includes('mp4') || lower.includes('aac')) return 'm4a'
  if (lower.includes('wav')) return 'wav'
  return 'webm'
}

export function permissionErrorMessage(error: any, subject = '语音输入') {
  const name = error?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return `麦克风权限被拒绝，请在浏览器里允许${subject}使用麦克风。`
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用麦克风，请检查输入设备。'
  return error?.message || '无法启动麦克风录音。'
}
