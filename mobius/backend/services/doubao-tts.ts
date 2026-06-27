import * as crypto from 'crypto';

import * as adminSettings from './admin-settings';

const DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_SAMPLE_RATE = 24000;
const MAX_TEXT_CHARS = 1200;
const FETCH_TIMEOUT_MS = 60_000;
const TTS_CACHE_LIMIT = 128;
const ttsAudioCache = new Map<string, { audio: Buffer; mimeType: string; provider_log_id: string }>();

const DOUBAO_TTS_VOICES = Object.freeze([
  {
    id: 'zh_female_vv_uranus_bigtts',
    label: 'vivi 2.0',
    language: 'zh-CN',
    gender: 'female',
    category: 'general',
    description: '自然清亮的通用女声',
  },
  {
    id: 'zh_female_xiaohe_uranus_bigtts',
    label: '小何',
    language: 'zh-CN',
    gender: 'female',
    category: 'general',
    description: '温和耐听的通用女声',
  },
  {
    id: 'zh_male_m191_uranus_bigtts',
    label: '云舟',
    language: 'zh-CN',
    gender: 'male',
    category: 'general',
    description: '稳重清晰的通用男声',
  },
  {
    id: 'zh_male_taocheng_uranus_bigtts',
    label: '小天',
    language: 'zh-CN',
    gender: 'male',
    category: 'general',
    description: '明快自然的通用男声',
  },
  {
    id: 'saturn_zh_female_cancan_tob',
    label: '知性灿灿',
    language: 'zh-CN',
    gender: 'female',
    category: 'role',
    description: '偏知性表达的角色女声',
  },
  {
    id: 'saturn_zh_female_keainvsheng_tob',
    label: '可爱女生',
    language: 'zh-CN',
    gender: 'female',
    category: 'role',
    description: '轻快活泼的角色女声',
  },
  {
    id: 'saturn_zh_female_tiaopigongzhu_tob',
    label: '调皮公主',
    language: 'zh-CN',
    gender: 'female',
    category: 'role',
    description: '更有角色感的俏皮女声',
  },
  {
    id: 'saturn_zh_male_shuanglangshaonian_tob',
    label: '爽朗少年',
    language: 'zh-CN',
    gender: 'male',
    category: 'role',
    description: '明亮爽朗的少年音色',
  },
  {
    id: 'saturn_zh_male_tiancaitongzhuo_tob',
    label: '天才同桌',
    language: 'zh-CN',
    gender: 'male',
    category: 'role',
    description: '偏年轻化的角色男声',
  },
  {
    id: 'en_male_tim_uranus_bigtts',
    label: 'Tim',
    language: 'en-US',
    gender: 'male',
    category: 'general',
    description: '英文通用男声',
  },
]);
const DOUBAO_TTS_VOICE_IDS = new Set<string>(DOUBAO_TTS_VOICES.map((voice) => voice.id));

class TtsError extends Error {
  code: string;
  status: number;
  logId: string;
  constructor(message: string, opts: { code?: string; status?: number; logId?: string } = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = opts.code || 'TTS_FAILED';
    this.status = opts.status || 500;
    this.logId = opts.logId || '';
  }
}

function envCredentialValue(value: any): string {
  const cleaned = String(value || '').trim();
  if (!cleaned) return '';
  if (/^replace-me(?:-|$)/i.test(cleaned) || /^change-me(?:-|$)/i.test(cleaned)) return '';
  return cleaned;
}

function pickCredential(storedKey: string, envKey: string): string {
  const stored = (adminSettings.getDoubaoVoice() as any).tts[storedKey];
  if (stored && !/^replace-me(?:-|$)/i.test(stored)) return stored;
  return envCredentialValue(process.env[envKey]);
}

function pickNonSecret(storedKey: string, envKey: string, fallback: string): string {
  const stored = (adminSettings.getDoubaoVoice() as any).tts[storedKey];
  if (stored) return stored;
  return process.env[envKey] || fallback;
}

function resolveCredentials(): { appId: string; accessToken: string; resourceId: string; endpoint: string } {
  return {
    appId: pickCredential('appId', 'DOUBAO_TTS_APP_ID'),
    accessToken: pickCredential('accessToken', 'DOUBAO_TTS_ACCESS_TOKEN'),
    resourceId: pickNonSecret('resourceId', 'DOUBAO_TTS_RESOURCE_ID', DEFAULT_RESOURCE_ID),
    endpoint: pickNonSecret('endpoint', 'DOUBAO_TTS_ENDPOINT', DEFAULT_ENDPOINT),
  };
}

function resolveCredentialsFromPayload(payload: any = {}): { appId: string; accessToken: string; resourceId: string; endpoint: string } {
  const obj = payload && typeof payload === 'object' ? payload : {};
  return {
    appId: String(obj.appId ?? '').trim(),
    accessToken: String(obj.accessToken ?? '').trim(),
    resourceId: String(obj.resourceId ?? '').trim() || DEFAULT_RESOURCE_ID,
    endpoint: String(obj.endpoint ?? '').trim() || DEFAULT_ENDPOINT,
  };
}

function normalizeText(text: any): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function normalizeVoice(voice: any): string {
  const value = String(voice || '').trim();
  if (!value) return DEFAULT_VOICE;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return DEFAULT_VOICE;
  return DOUBAO_TTS_VOICE_IDS.has(value) ? value : DEFAULT_VOICE;
}

function normalizeFormat(format: any): string {
  return String(format || '').trim().toLowerCase() === 'wav' ? 'wav' : DEFAULT_FORMAT;
}

function getTtsVoices(): any[] {
  return DOUBAO_TTS_VOICES.map((voice) => ({
    ...voice,
    default: voice.id === DEFAULT_VOICE,
  }));
}

function buildTtsCacheKey({ credentials, text, voice, format }: { credentials: any; text: string; voice: string; format: string }): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      endpoint: credentials.endpoint || DEFAULT_ENDPOINT,
      resourceId: credentials.resourceId || DEFAULT_RESOURCE_ID,
      appId: credentials.appId || '',
      accessToken: credentials.accessToken || '',
      text,
      voice,
      format,
      sampleRate: DEFAULT_SAMPLE_RATE,
    }))
    .digest('hex');
}

function getCachedSpeech(cacheKey: string): { audio: Buffer; mimeType: string; provider_log_id: string } | null {
  const entry = ttsAudioCache.get(cacheKey);
  if (!entry) return null;
  ttsAudioCache.delete(cacheKey);
  ttsAudioCache.set(cacheKey, entry);
  return {
    ...entry,
    audio: Buffer.from(entry.audio),
  };
}

function setCachedSpeech(cacheKey: string, entry: { audio: Buffer; mimeType: string; provider_log_id: string }): void {
  if (ttsAudioCache.has(cacheKey)) ttsAudioCache.delete(cacheKey);
  ttsAudioCache.set(cacheKey, {
    ...entry,
    audio: Buffer.from(entry.audio),
  });
  while (ttsAudioCache.size > TTS_CACHE_LIMIT) {
    const oldestKey = ttsAudioCache.keys().next().value;
    if (!oldestKey) break;
    ttsAudioCache.delete(oldestKey);
  }
}

function clearTtsCache(): void {
  ttsAudioCache.clear();
}

function getTtsCacheStats(): { limit: number; size: number } {
  return {
    limit: TTS_CACHE_LIMIT,
    size: ttsAudioCache.size,
  };
}

function asTtsError(error: any, fallbackMessage: string = '语音合成失败，请稍后重试。', fallbackCode: string = 'TTS_FAILED'): TtsError {
  if (error instanceof TtsError) return error;
  const message = String(error?.message || '');
  if (/401|403|auth|access|permission|resource|grant|credential|key|token/i.test(message)) {
    return new TtsError('TTS 鉴权或资源授权失败，请检查后端凭据配置。', {
      code: 'TTS_AUTH_FAILED',
      status: 502,
      logId: error?.logId || '',
    });
  }
  if (/timeout|aborted|超时/i.test(message)) {
    return new TtsError('TTS 服务响应超时，请稍后重试。', {
      code: 'TTS_TIMEOUT',
      status: 504,
      logId: error?.logId || '',
    });
  }
  return new TtsError(fallbackMessage, { code: fallbackCode, status: 500, logId: error?.logId || '' });
}

function parseTtsLine(line: string, logId: string = ''): any {
  try {
    return JSON.parse(line);
  } catch {
    throw new TtsError('TTS 服务返回了无法解析的数据。', {
      code: 'TTS_BAD_RESPONSE',
      status: 502,
      logId,
    });
  }
}

interface SynthesizeSpeechArgs {
  user?: any;
  text?: any;
  voice?: string;
  format?: string;
  credentials?: { appId: string; accessToken: string; resourceId: string; endpoint: string };
}

async function synthesizeSpeech({ user, text, voice = DEFAULT_VOICE, format = DEFAULT_FORMAT, credentials: overrideCredentials }: SynthesizeSpeechArgs = {}): Promise<any> {
  const safeText = normalizeText(text);
  if (!safeText) {
    throw new TtsError('播报文本为空。', { code: 'TTS_TEXT_EMPTY', status: 400 });
  }

  const credentials = overrideCredentials || resolveCredentials();
  if (!credentials.appId || !credentials.accessToken) {
    throw new TtsError('TTS 凭据未配置。', { code: 'TTS_NOT_CONFIGURED', status: 503 });
  }

  const requestId = crypto.randomUUID();
  const safeVoice = normalizeVoice(voice);
  const safeFormat = normalizeFormat(format);
  const cacheKey = buildTtsCacheKey({
    credentials,
    text: safeText,
    voice: safeVoice,
    format: safeFormat,
  });
  const cached = getCachedSpeech(cacheKey);
  if (cached) {
    return {
      ...cached,
      request_id: requestId,
      text: safeText,
      voice: safeVoice,
      cache_hit: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(credentials.endpoint || DEFAULT_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Key': credentials.appId,
        'X-Api-Access-Key': credentials.accessToken,
        'X-Api-Resource-Id': credentials.resourceId || DEFAULT_RESOURCE_ID,
        'X-Api-Request-Id': requestId,
      },
      body: JSON.stringify({
        user: {
          uid: `mobius-assistant-tts-${user?.id || 'anonymous'}`,
        },
        req_params: {
          speaker: safeVoice,
          audio_params: {
            format: safeFormat,
            sample_rate: DEFAULT_SAMPLE_RATE,
          },
          text: safeText,
        },
      }),
    });
  } catch (error) {
    clearTimeout(timer);
    throw asTtsError(error);
  }
  clearTimeout(timer);

  const logId = response.headers.get('x-tt-logid') || response.headers.get('x-tt-log-id') || '';
  const raw = await response.text();
  if (!response.ok) {
    throw new TtsError('TTS 服务请求失败。', {
      code: response.status === 401 || response.status === 403 ? 'TTS_AUTH_FAILED' : 'TTS_PROVIDER_FAILED',
      status: response.status === 401 || response.status === 403 ? 502 : 502,
      logId,
    });
  }

  const audioChunks: Buffer[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new TtsError('TTS 服务没有返回音频数据。', {
      code: 'TTS_EMPTY_AUDIO',
      status: 502,
      logId,
    });
  }

  for (const line of lines) {
    const frame = parseTtsLine(line, logId);
    const code = Number(frame?.code ?? 0);
    if (code === 20000000) continue;
    if (code !== 0) {
      throw new TtsError(frame?.message || 'TTS 服务返回错误。', {
        code: 'TTS_PROVIDER_FAILED',
        status: 502,
        logId,
      });
    }
    if (typeof frame?.data === 'string' && frame.data) {
      audioChunks.push(Buffer.from(frame.data, 'base64'));
    }
  }

  const audio = Buffer.concat(audioChunks);
  if (audio.length === 0) {
    throw new TtsError('TTS 服务没有返回音频数据。', {
      code: 'TTS_EMPTY_AUDIO',
      status: 502,
      logId,
    });
  }

  const result = {
    audio,
    mimeType: safeFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
    request_id: requestId,
    provider_log_id: logId,
    text: safeText,
    voice: safeVoice,
    cache_hit: false,
  };
  setCachedSpeech(cacheKey, {
    audio: result.audio,
    mimeType: result.mimeType,
    provider_log_id: result.provider_log_id,
  });
  return result;
}

function isDoubaoTtsConfigured(): boolean {
  const { appId, accessToken } = resolveCredentials();
  return !!(appId && accessToken);
}

export {
  DEFAULT_VOICE,
  TTS_CACHE_LIMIT,
  TtsError,
  asTtsError,
  clearTtsCache,
  getTtsCacheStats,
  getTtsVoices,
  isDoubaoTtsConfigured,
  resolveCredentials,
  resolveCredentialsFromPayload,
  synthesizeSpeech,
};
