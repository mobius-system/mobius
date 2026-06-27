import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { spawn } from 'child_process';

import * as adminSettings from './admin-settings';

const CLIENT_FULL_REQUEST = 0b0001;
const CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const SERVER_FULL_RESPONSE = 0b1001;
const SERVER_ERROR_RESPONSE = 0b1111;
const POS_SEQUENCE = 0b0001;
const NEG_WITH_SEQUENCE = 0b0011;
const JSON_SERIALIZATION = 0b0001;
const GZIP_COMPRESSION = 0b0001;

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const SAMPLE_RATE = 16000;
const SAMPLE_BYTES = 2;
const CHANNELS = 1;
const CHUNK_MS = 200;
const MAX_AUDIO_SECONDS = 180;
const MIN_PCM_BYTES = SAMPLE_RATE * SAMPLE_BYTES * CHANNELS * 0.25;

class AsrError extends Error {
  code: string;
  status: number;
  logId: string;
  constructor(message: string, opts: any = {}) {
    super(message);
    this.name = 'AsrError';
    this.code = opts.code || 'ASR_FAILED';
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
  const stored = adminSettings.getDoubaoVoice().asr[storedKey];
  if (stored && !/^replace-me(?:-|$)/i.test(stored)) return stored;
  return envCredentialValue(process.env[envKey]);
}

function pickNonSecret(storedKey: string, envKey: string, fallback: string): string {
  const stored = adminSettings.getDoubaoVoice().asr[storedKey];
  if (stored) return stored;
  return process.env[envKey] || fallback;
}

function resolveCredentials(): any {
  return {
    appId: pickCredential('appId', 'DOUBAO_ASR_APP_ID'),
    accessToken: pickCredential('accessToken', 'DOUBAO_ASR_ACCESS_TOKEN'),
    resourceId: pickNonSecret('resourceId', 'DOUBAO_ASR_RESOURCE_ID', DEFAULT_RESOURCE_ID),
    endpoint: pickNonSecret('endpoint', 'DOUBAO_ASR_ENDPOINT', DEFAULT_ENDPOINT),
  };
}

function resolveCredentialsFromPayload(payload: any = {}): any {
  const obj = payload && typeof payload === 'object' ? payload : {};
  return {
    appId: String(obj.appId ?? '').trim(),
    accessToken: String(obj.accessToken ?? '').trim(),
    resourceId: String(obj.resourceId ?? '').trim() || DEFAULT_RESOURCE_ID,
    endpoint: String(obj.endpoint ?? '').trim() || DEFAULT_ENDPOINT,
  };
}

function asAsrError(error: any, fallbackMessage: string = '语音转写失败，请稍后重试。', fallbackCode: string = 'ASR_FAILED'): AsrError {
  if (error instanceof AsrError) return error;
  const message = String(error?.message || '');
  if (/握手失败|401|403|auth|access|permission|resource|grant|credential|key|token/i.test(message)) {
    return new AsrError('ASR 鉴权或资源授权失败，请检查后端凭据配置。', {
      code: 'ASR_AUTH_FAILED',
      status: 502,
      logId: error?.logId || '',
    });
  }
  if (/超时|timeout/i.test(message)) {
    return new AsrError('ASR 服务响应超时，请稍后重试。', {
      code: 'ASR_TIMEOUT',
      status: 504,
      logId: error?.logId || '',
    });
  }
  if (/启动 ffmpeg 失败|spawn .*ffmpeg.*ENOENT/i.test(message)) {
    return new AsrError('服务器缺少 ffmpeg，无法处理浏览器录音格式。', {
      code: 'ASR_FFMPEG_MISSING',
      status: 503,
    });
  }
  if (/转码|ffmpeg/i.test(message)) {
    return new AsrError('音频格式无法识别或转换失败，请重新录制。', {
      code: 'ASR_AUDIO_CONVERT_FAILED',
      status: 400,
    });
  }
  return new AsrError(fallbackMessage, { code: fallbackCode, status: 500 });
}

function isDoubaoAsrConfigured(): boolean {
  const { appId, accessToken } = resolveCredentials();
  return !!(appId && accessToken);
}

function makeHeader(messageType: number, flags: number): Buffer {
  return Buffer.from([
    (0b0001 << 4) | 1,
    (messageType << 4) | flags,
    (JSON_SERIALIZATION << 4) | GZIP_COMPRESSION,
    0,
  ]);
}

function packInt32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
}

function packUInt32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function fullRequest(seq: number): Buffer {
  const payload = {
    user: { uid: 'mobius_assistant_asr' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: SAMPLE_RATE,
      bits: 16,
      channel: CHANNELS,
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
    },
  };
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return Buffer.concat([
    makeHeader(CLIENT_FULL_REQUEST, POS_SEQUENCE),
    packInt32(seq),
    packUInt32(body.length),
    body,
  ]);
}

function audioPacket(seq: number, chunk: Buffer, isLast: boolean): Buffer {
  const flags = isLast ? NEG_WITH_SEQUENCE : POS_SEQUENCE;
  const wireSeq = isLast ? -seq : seq;
  const body = zlib.gzipSync(chunk);
  return Buffer.concat([
    makeHeader(CLIENT_AUDIO_ONLY_REQUEST, flags),
    packInt32(wireSeq),
    packUInt32(body.length),
    body,
  ]);
}

function parseResponse(data: any): any {
  if (!Buffer.isBuffer(data) || data.length < 4) {
    throw new Error('豆包 ASR 返回了无效响应');
  }
  const headerBytes = (data[0] & 0x0f) * 4;
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let payload: any = data.slice(headerBytes);
  const result: any = {
    message_type: messageType,
    flags,
    is_last: !!(flags & 0b0010),
    code: 0,
    payload: null,
  };

  if (flags & 0b0001) {
    if (payload.length < 4) throw new Error('豆包 ASR 响应缺少 sequence');
    result.sequence = payload.readInt32BE(0);
    payload = payload.slice(4);
  }
  if (flags & 0b0100) {
    if (payload.length < 4) throw new Error('豆包 ASR 响应缺少 event');
    result.event = payload.readInt32BE(0);
    payload = payload.slice(4);
  }
  if (messageType === SERVER_FULL_RESPONSE) {
    if (payload.length < 4) throw new Error('豆包 ASR 响应缺少 payload size');
    result.payload_size = payload.readUInt32BE(0);
    payload = payload.slice(4);
  } else if (messageType === SERVER_ERROR_RESPONSE) {
    if (payload.length < 8) throw new Error('豆包 ASR 错误响应格式无效');
    result.code = payload.readInt32BE(0);
    result.payload_size = payload.readUInt32BE(4);
    payload = payload.slice(8);
  }

  if (payload.length > 0 && compression === GZIP_COMPRESSION) {
    payload = zlib.gunzipSync(payload);
  }
  if (payload.length > 0 && serialization === JSON_SERIALIZATION) {
    result.payload = JSON.parse(payload.toString('utf8'));
  } else if (payload.length > 0) {
    result.payload = payload.toString('utf8');
  }
  return result;
}

function collectTexts(value: any, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectTexts(item, out));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  Object.entries(value).forEach(([key, item]) => {
    if (key === 'text' && typeof item === 'string' && item.trim()) {
      out.push(item.trim());
      return;
    }
    collectTexts(item, out);
  });
  return out;
}

function uniqueTexts(texts: any[]): string[] {
  const seen = new Set();
  const out: string[] = [];
  texts.forEach((text) => {
    const normalized = String(text || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  });
  return out;
}

function bestText(texts: any[]): string {
  const unique = uniqueTexts(texts);
  if (unique.length === 0) return '';
  return unique.slice().sort((a, b) => b.length - a.length)[0];
}

function encodeClientFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) {
    masked[i] = body[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

class MinimalWssClient {
  socket: any;
  buffer: Buffer;
  queue: any[];
  waiters: any[];
  closed: boolean;
  fragment: any;

  constructor(socket: any, initialBuffer: Buffer = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = initialBuffer;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.fragment = null;

    socket.on('data', (chunk: any) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseAvailableFrames();
    });
    socket.on('error', (err: any) => this.finishWithError(err));
    socket.on('close', () => this.finishWithClose());
    if (this.buffer.length > 0) this.parseAvailableFrames();
  }

  static connect(rawUrl: string, headers: any = {}, timeoutMs: number = 15000): Promise<MinimalWssClient> {
    const url = new URL(rawUrl);
    if (url.protocol !== 'wss:') throw new Error('豆包 ASR endpoint 必须是 wss://');
    const port = Number(url.port || 443);
    const pathWithQuery = `${url.pathname || '/'}${url.search || ''}`;
    const key = crypto.randomBytes(16).toString('base64');

    return new Promise((resolve, reject) => {
      const socket: any = tls.connect({
        host: url.hostname,
        port,
        servername: url.hostname,
      });
      let settled = false;
      let raw = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error('连接豆包 ASR 超时'));
      }, timeoutMs);

      const fail = (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };

      socket.once('error', fail);
      socket.once('secureConnect', () => {
        const headerLines = [
          `GET ${pathWithQuery} HTTP/1.1`,
          `Host: ${url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          '',
          '',
        ];
        socket.write(headerLines.join('\r\n'));
      });

      const onData = (chunk: any) => {
        raw = Buffer.concat([raw, chunk]);
        const end = raw.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', fail);
        const headerText = raw.slice(0, end).toString('utf8');
        const firstLine = headerText.split('\r\n')[0] || '';
        if (!/^HTTP\/1\.[01]\s+101\b/.test(firstLine)) {
          socket.destroy();
          reject(new Error(`豆包 ASR WebSocket 握手失败: ${firstLine || 'empty response'}`));
          return;
        }
        const rest = raw.slice(end + 4);
        resolve(new MinimalWssClient(socket, rest));
      };

      socket.on('data', onData);
    });
  }

  sendBinary(payload: Buffer): void {
    if (this.closed) throw new Error('豆包 ASR 连接已关闭');
    this.socket.write(encodeClientFrame(0x2, payload));
  }

  sendPong(payload: Buffer): void {
    if (!this.closed) this.socket.write(encodeClientFrame(0xA, payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.write(encodeClientFrame(0x8)); } catch {}
    try { this.socket.end(); } catch {}
  }

  finishWithError(err: any): void {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    waiters.forEach(({ reject }) => reject(err));
  }

  finishWithClose(): void {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    waiters.forEach(({ resolve }) => resolve({ type: 'close' }));
  }

  enqueue(message: any): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    this.queue.push(message);
  }

  receive(timeoutMs: number = 30000): Promise<any> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve({ type: 'close' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((item) => item.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('等待豆包 ASR 响应超时'));
      }, timeoutMs);
      this.waiters.push({
        resolve: (value: any) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err: any) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  parseAvailableFrames(): void {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = !!(first & 0x80);
      const opcode = first & 0x0f;
      const masked = !!(second & 0x80);
      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLen = this.buffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.finishWithError(new Error('豆包 ASR 响应过大'));
          return;
        }
        len = Number(bigLen);
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.slice(offset, offset + len);
      if (masked) {
        const mask = this.buffer.slice(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
      }
      this.buffer = this.buffer.slice(offset + len);

      if (opcode === 0x8) {
        this.finishWithClose();
        return;
      }
      if (opcode === 0x9) {
        this.sendPong(payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x0 && this.fragment) {
        this.fragment.chunks.push(payload);
        if (fin) {
          const message = Buffer.concat(this.fragment.chunks);
          const type = this.fragment.opcode === 0x1 ? 'text' : 'binary';
          this.fragment = null;
          this.enqueue({ type, data: message });
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.enqueue({ type: opcode === 0x1 ? 'text' : 'binary', data: payload });
        } else {
          this.fragment = { opcode, chunks: [payload] };
        }
      }
    }
  }
}

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-t', String(MAX_AUDIO_SECONDS),
    '-i', inputPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ac', String(CHANNELS),
    '-ar', String(SAMPLE_RATE),
    '-f', 's16le',
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const child: any = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('录音转码超时'));
    }, 90000);
    child.stderr.on('data', (chunk: any) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err: any) => {
      clearTimeout(timer);
      reject(new Error(`启动 ffmpeg 失败: ${err.message}`));
    });
    child.on('close', (code: any) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`录音转码失败${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

async function normalizeAudioToPcm(inputPath: string): Promise<Buffer> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-asr-pcm-'));
  const outputPath = path.join(tempDir, 'audio.pcm');
  try {
    await runFfmpeg(inputPath, outputPath);
    const pcm = fs.readFileSync(outputPath);
    if (pcm.length < MIN_PCM_BYTES) {
      throw new AsrError('录音太短，请至少录制一小段清晰语音。', {
        code: 'ASR_AUDIO_TOO_SHORT',
        status: 400,
      });
    }
    return pcm;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function transcribePcm(pcm: Buffer, opts: any = {}): Promise<any> {
  const credentials = opts.credentials || resolveCredentials();
  if (!credentials.appId || !credentials.accessToken) {
    throw new AsrError('豆包 ASR 未配置，请在管理中心 → 管理员小莫配置 中设置 ASR 凭证。', {
      code: 'ASR_NOT_CONFIGURED',
      status: 503,
    });
  }

  const requestId = crypto.randomUUID();
  const headers = {
    'X-Api-App-Key': credentials.appId,
    'X-Api-Access-Key': credentials.accessToken,
    'X-Api-Resource-Id': credentials.resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': crypto.randomUUID(),
  };
  const ws = await MinimalWssClient.connect(credentials.endpoint, headers);
  const texts: string[] = [];
  try {
    let seq = 1;
    ws.sendBinary(fullRequest(seq));
    const first = await ws.receive(15000);
    if (first.type === 'binary') {
      const response = parseResponse(first.data);
      if (response.code) throw new Error(typeof response.payload === 'string' ? response.payload : JSON.stringify(response.payload));
      texts.push(...collectTexts(response.payload));
    }

    seq += 1;
    const chunkSize = SAMPLE_RATE * SAMPLE_BYTES * CHANNELS * CHUNK_MS / 1000;
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      const chunk = pcm.slice(offset, Math.min(offset + chunkSize, pcm.length));
      const isLast = offset + chunkSize >= pcm.length;
      ws.sendBinary(audioPacket(seq, chunk, isLast));
      if (!isLast) seq += 1;
      if (opts.paceMs) await new Promise((resolve) => setTimeout(resolve, opts.paceMs));
    }

    while (true) {
      const msg = await ws.receive(30000);
      if (msg.type === 'close') break;
      if (msg.type !== 'binary') continue;
      const response = parseResponse(msg.data);
      if (response.code) {
        const detail = typeof response.payload === 'string' ? response.payload : JSON.stringify(response.payload);
        throw new Error(detail || `豆包 ASR 返回错误码 ${response.code}`);
      }
      texts.push(...collectTexts(response.payload));
      if (response.is_last) break;
    }
  } finally {
    ws.close();
  }

  const alternatives = uniqueTexts(texts);
  const text = bestText(alternatives);
  if (!text) {
    throw new AsrError('没有识别到清晰语音，请靠近麦克风后重新录制。', {
      code: 'ASR_EMPTY_TEXT',
      status: 422,
    });
  }
  return {
    request_id: requestId,
    text,
    alternatives,
    pcm_bytes: pcm.length,
    duration_seconds: pcm.length / (SAMPLE_RATE * SAMPLE_BYTES * CHANNELS),
  };
}

async function transcribeAudioFile(filePath: string, opts: any = {}): Promise<any> {
  try {
    const pcm = await normalizeAudioToPcm(filePath);
    return await transcribePcm(pcm, opts);
  } catch (error) {
    throw asAsrError(error);
  }
}

async function transcribePcmWithCredentials(pcm: Buffer, credentials: any): Promise<any> {
  return transcribePcm(pcm, { credentials });
}

function safeUploadExtension(file: any): string {
  const raw = String(file?.originalname || '');
  const ext = path.extname(raw).replace(/[^A-Za-z0-9.]/g, '').slice(0, 16);
  return ext || '.webm';
}

async function transcribeBrowserAudio({ user, file }: any): Promise<any> {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new AsrError('录音内容为空，请重新录制一段清晰语音。', {
      code: 'ASR_AUDIO_EMPTY',
      status: 400,
    });
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-asr-upload-'));
  const inputPath = path.join(tempDir, `audio${safeUploadExtension(file)}`);
  try {
    fs.writeFileSync(inputPath, file.buffer);
    const result = await transcribeAudioFile(inputPath, { user });
    return {
      ...result,
      mime_type: file.mimetype || '',
      original_name: file.originalname || '',
    };
  } catch (error) {
    throw asAsrError(error);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

export {
  AsrError,
  isDoubaoAsrConfigured,
  normalizeAudioToPcm,
  resolveCredentials,
  resolveCredentialsFromPayload,
  transcribeAudioFile,
  transcribeBrowserAudio,
  transcribePcm,
  transcribePcmWithCredentials,
};
