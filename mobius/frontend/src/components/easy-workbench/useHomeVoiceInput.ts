import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../store'
import {
  permissionErrorMessage,
  recordingFileExtension,
  supportedVoiceMimeType,
  type VoiceInputState,
  type VoiceTranscribeResponse,
  VOICE_RECORDING_MAX_MS,
} from '../../services/assistant-voice'

type UseHomeVoiceInputOptions = {
  disabled?: boolean
  onError: (message: string) => void
  onTranscript: (text: string) => void
}

export function useHomeVoiceInput({ disabled = false, onError, onTranscript }: UseHomeVoiceInputOptions) {
  const [state, setState] = useState<VoiceInputState>('idle')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordingFailedRef = useRef(false)
  const stopTimerRef = useRef<number | null>(null)
  const tickTimerRef = useRef<number | null>(null)
  const transcribeControllerRef = useRef<AbortController | null>(null)
  const abortReasonRef = useRef<'cancel' | 'timeout' | null>(null)
  const permissionPendingRef = useRef(false)
  const permissionGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const disabledRef = useRef(disabled)
  const onErrorRef = useRef(onError)
  const onTranscriptRef = useRef(onTranscript)

  useEffect(() => { disabledRef.current = disabled }, [disabled])
  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { onTranscriptRef.current = onTranscript }, [onTranscript])

  const clearTimers = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current)
      tickTimerRef.current = null
    }
  }, [])

  const stopStream = useCallback(() => {
    const stream = mediaStreamRef.current
    mediaStreamRef.current = null
    stream?.getTracks().forEach(track => {
      try { track.stop() } catch {}
    })
  }, [])

  const reportError = useCallback((message: string) => {
    if (!mountedRef.current) return
    setState('error')
    onErrorRef.current(message)
  }, [])

  const transcribe = useCallback(async (blob: Blob) => {
    if (!blob || blob.size === 0) {
      reportError('录音内容为空，请重新录制一段清晰语音。')
      return
    }

    const controller = new AbortController()
    transcribeControllerRef.current = controller
    abortReasonRef.current = null
    const timeout = window.setTimeout(() => {
      abortReasonRef.current = 'timeout'
      controller.abort()
    }, 125_000)
    const mimeType = blob.type || 'audio/webm'
    const form = new FormData()
    form.append('audio', blob, `home-voice-${Date.now()}.${recordingFileExtension(mimeType)}`)

    setState('transcribing')
    onErrorRef.current('')
    try {
      const result = await api('/api/assistant/transcribe', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      }) as VoiceTranscribeResponse
      if (!mountedRef.current) return
      const text = String(result.text || '').trim()
      if (!text) {
        reportError('没有识别到有效语音，请靠近麦克风并重新录制。')
        return
      }
      setState('idle')
      setRecordingSeconds(0)
      onErrorRef.current('')
      onTranscriptRef.current(text)
    } catch (error: any) {
      if (!mountedRef.current || abortReasonRef.current === 'cancel') return
      reportError(abortReasonRef.current === 'timeout'
        ? '语音转写网络超时，请稍后重试。'
        : (error?.message || '语音转写失败，请稍后重试。'))
    } finally {
      window.clearTimeout(timeout)
      if (transcribeControllerRef.current === controller) transcribeControllerRef.current = null
      abortReasonRef.current = null
    }
  }, [reportError])

  const stop = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    try { recorder.requestData() } catch {}
    try { recorder.stop() } catch {}
  }, [])

  const start = useCallback(async () => {
    if (disabledRef.current || permissionPendingRef.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      reportError('当前浏览器不支持录音，请换用支持 MediaRecorder 的浏览器。')
      return
    }

    permissionPendingRef.current = true
    const permissionGeneration = ++permissionGenerationRef.current
    onErrorRef.current('')
    setRecordingSeconds(0)
    chunksRef.current = []
    recordingFailedRef.current = false

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (!mountedRef.current || disabledRef.current || permissionGeneration !== permissionGenerationRef.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }

      const mimeType = supportedVoiceMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        recordingFailedRef.current = true
        clearTimers()
        stopStream()
        reportError('浏览器录音失败，请重新录制。')
        try {
          if (recorder.state !== 'inactive') recorder.stop()
        } catch {}
      }
      recorder.onstop = () => {
        clearTimers()
        stopStream()
        mediaRecorderRef.current = null
        if (recordingFailedRef.current || !mountedRef.current) return
        const type = recorder.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type })
        chunksRef.current = []
        void transcribe(blob)
      }

      recorder.start(250)
      setState('recording')
      tickTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(value => value + 1)
      }, 1000)
      stopTimerRef.current = window.setTimeout(stop, VOICE_RECORDING_MAX_MS)
    } catch (error: any) {
      clearTimers()
      stopStream()
      mediaRecorderRef.current = null
      if (permissionGeneration === permissionGenerationRef.current) {
        reportError(permissionErrorMessage(error, '任务输入'))
      }
    } finally {
      if (permissionGeneration === permissionGenerationRef.current) permissionPendingRef.current = false
    }
  }, [clearTimers, reportError, stop, stopStream, transcribe])

  const cancel = useCallback(() => {
    permissionGenerationRef.current += 1
    permissionPendingRef.current = false
    recordingFailedRef.current = true
    clearTimers()
    const recorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
      try { recorder.stop() } catch {}
    }
    stopStream()
    if (transcribeControllerRef.current) {
      abortReasonRef.current = 'cancel'
      transcribeControllerRef.current.abort()
      transcribeControllerRef.current = null
    }
    chunksRef.current = []
    if (mountedRef.current) {
      setState('idle')
      setRecordingSeconds(0)
    }
  }, [clearTimers, stopStream])

  const toggle = useCallback(() => {
    if (state === 'recording') stop()
    else if (state !== 'transcribing') void start()
  }, [start, state, stop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancel()
    }
  }, [cancel])

  return { state, recordingSeconds, toggle, cancel }
}
