// =====================================================================
// 可复用的语音输入 hook — 欢迎页输入框用 (会话页 chat.tsx 有一份内联实现, 逻辑对齐).
// 录音 → 停止 → 转写 (/api/assistant/transcribe) → 把文本追加进输入框.
// =====================================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../store'
import {
  permissionErrorMessage,
  recordingFileExtension,
  supportedVoiceMimeType,
  type VoiceInputState,
  type VoiceTranscribeResponse,
  VOICE_RECORDING_MAX_MS,
} from './assistant-voice'

export function useVoiceInput(opts: { onTranscribed: (text: string) => void; onError?: (msg: string) => void }) {
  const [voiceState, setVoiceState] = useState<VoiceInputState>('idle')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceRecordFailedRef = useRef(false)
  const voiceStopTimerRef = useRef<number | null>(null)
  const voiceTickTimerRef = useRef<number | null>(null)
  // 回调放 ref, 避免闭包过期
  const cbRef = useRef(opts)
  cbRef.current = opts

  const clearVoiceTimers = useCallback(() => {
    if (voiceTickTimerRef.current) { window.clearInterval(voiceTickTimerRef.current); voiceTickTimerRef.current = null }
    if (voiceStopTimerRef.current) { window.clearTimeout(voiceStopTimerRef.current); voiceStopTimerRef.current = null }
  }, [])

  const stopVoiceStream = useCallback(() => {
    try { mediaStreamRef.current?.getTracks().forEach(track => track.stop()) } catch {}
    mediaStreamRef.current = null
  }, [])

  // 转写: blob → /api/assistant/transcribe → 追加进输入框
  const submitVoiceBlob = useCallback(async (blob: Blob) => {
    setVoiceState('transcribing')
    try {
      const ext = recordingFileExtension(blob.type)
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type })
      const form = new FormData()
      form.append('file', file)
      form.append('source', 'welcome-input')
      const result = await api('/api/assistant/transcribe', { method: 'POST', body: form }) as VoiceTranscribeResponse
      const text = (result?.text || '').trim()
      if (text) cbRef.current.onTranscribed(text)
      setVoiceState('idle')
    } catch (error: any) {
      setVoiceState('error')
      cbRef.current.onError?.(error?.message || '语音转写失败')
      setTimeout(() => setVoiceState('idle'), 1800)
    }
  }, [])

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    try { recorder.requestData() } catch {}
    try { recorder.stop() } catch {}
  }, [])

  const startVoiceRecording = useCallback(async () => {
    if (voiceState === 'transcribing') return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceState('error')
      cbRef.current.onError?.('当前浏览器不支持录音，请换用支持 MediaRecorder 的浏览器。')
      return
    }
    setRecordingSeconds(0)
    voiceChunksRef.current = []
    voiceRecordFailedRef.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const mimeType = supportedVoiceMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) voiceChunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        voiceRecordFailedRef.current = true
        clearVoiceTimers()
        stopVoiceStream()
        setVoiceState('error')
        cbRef.current.onError?.('浏览器录音失败，请重新录制。')
        try { if (recorder.state !== 'inactive') recorder.stop() } catch {}
      }
      recorder.onstop = () => {
        clearVoiceTimers()
        stopVoiceStream()
        mediaRecorderRef.current = null
        if (voiceRecordFailedRef.current) return
        const type = recorder.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(voiceChunksRef.current, { type })
        voiceChunksRef.current = []
        void submitVoiceBlob(blob)
      }
      recorder.start(250)
      setVoiceState('recording')
      voiceTickTimerRef.current = window.setInterval(() => setRecordingSeconds(v => v + 1), 1000)
      voiceStopTimerRef.current = window.setTimeout(() => stopVoiceRecording(), VOICE_RECORDING_MAX_MS)
    } catch (error: any) {
      clearVoiceTimers()
      stopVoiceStream()
      mediaRecorderRef.current = null
      setVoiceState('error')
      cbRef.current.onError?.(permissionErrorMessage(error, '欢迎页输入'))
    }
  }, [clearVoiceTimers, stopVoiceRecording, stopVoiceStream, submitVoiceBlob, voiceState])

  const toggleVoiceRecording = useCallback(() => {
    if (voiceState === 'recording') {
      stopVoiceRecording()
      return
    }
    void startVoiceRecording()
  }, [startVoiceRecording, stopVoiceRecording, voiceState])

  // 卸载时清理
  useEffect(() => () => {
    clearVoiceTimers()
    stopVoiceStream()
    try { mediaRecorderRef.current?.stop() } catch {}
  }, [clearVoiceTimers, stopVoiceStream])

  return { voiceState, recordingSeconds, toggleVoiceRecording }
}
