const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-assistant-tts-cache-'));
process.env.DB_PATH = path.join(tempRoot, 'mobius.db');
process.env.MOBIUS_DATA_PATH = tempRoot;
process.env.CORE_DATA_PATH = tempRoot;
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json');
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace');

process.env.DOUBAO_TTS_APP_ID = 'test-app';
process.env.DOUBAO_TTS_ACCESS_TOKEN = 'test-token';
process.env.DOUBAO_TTS_RESOURCE_ID = 'seed-tts-2.0';
process.env.DOUBAO_TTS_ENDPOINT = 'https://example.test/api/v3/tts/unidirectional';

const {
  DEFAULT_VOICE,
  TTS_CACHE_LIMIT,
  clearTtsCache,
  getTtsCacheStats,
  synthesizeSpeech,
} = require('../backend/services/doubao-tts');

function cleanup() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
}

process.on('exit', cleanup);

function createMockResponse(payload, logId) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'x-tt-logid' ? logId : '';
      },
    },
    async text() {
      return [
        JSON.stringify({ code: 0, data: Buffer.from(payload).toString('base64') }),
        JSON.stringify({ code: 20000000 }),
      ].join('\n');
    },
  };
}

async function withMockFetch(run) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    return createMockResponse(`audio-${calls.length}`, `log-${calls.length}`);
  };
  try {
    await run(calls);
  } finally {
    global.fetch = originalFetch;
    clearTtsCache();
  }
}

async function assertCacheHitForSameTextVoiceAndFormat() {
  await withMockFetch(async (calls) => {
    const first = await synthesizeSpeech({ user: { id: 'u-test' }, text: '  你好，小莫  ', voice: DEFAULT_VOICE });
    const second = await synthesizeSpeech({ user: { id: 'u-test' }, text: '你好，小莫', voice: DEFAULT_VOICE });

    assert.strictEqual(calls.length, 1, 'same normalized text and voice should reuse cached audio');
    assert.strictEqual(first.audio.toString(), 'audio-1');
    assert.strictEqual(second.audio.toString(), 'audio-1');
    assert.strictEqual(first.cache_hit, false);
    assert.strictEqual(second.cache_hit, true);
    assert.notStrictEqual(first.request_id, second.request_id, 'cache hits still get a fresh request id');
    assert.strictEqual(first.provider_log_id, 'log-1');
    assert.strictEqual(second.provider_log_id, 'log-1');
  });
}

async function assertCacheKeyIncludesVoiceAndFormat() {
  await withMockFetch(async (calls) => {
    await synthesizeSpeech({ user: { id: 'u-test' }, text: 'voice split', voice: DEFAULT_VOICE });
    await synthesizeSpeech({ user: { id: 'u-test' }, text: 'voice split', voice: 'zh_male_m191_uranus_bigtts' });
    const wav = await synthesizeSpeech({ user: { id: 'u-test' }, text: 'voice split', voice: DEFAULT_VOICE, format: 'wav' });

    assert.strictEqual(calls.length, 3, 'different voice or format should not share cache entries');
    assert.strictEqual(calls[0].body.req_params.speaker, DEFAULT_VOICE);
    assert.strictEqual(calls[1].body.req_params.speaker, 'zh_male_m191_uranus_bigtts');
    assert.strictEqual(calls[2].body.req_params.audio_params.format, 'wav');
    assert.strictEqual(wav.mimeType, 'audio/wav');
  });
}

async function assertLruEviction() {
  await withMockFetch(async (calls) => {
    for (let i = 0; i < TTS_CACHE_LIMIT; i += 1) {
      await synthesizeSpeech({ user: { id: 'u-test' }, text: `lru text ${i}`, voice: DEFAULT_VOICE });
    }
    assert.strictEqual(calls.length, TTS_CACHE_LIMIT);
    assert.deepStrictEqual(getTtsCacheStats(), { limit: TTS_CACHE_LIMIT, size: TTS_CACHE_LIMIT });

    await synthesizeSpeech({ user: { id: 'u-test' }, text: 'lru text 0', voice: DEFAULT_VOICE });
    assert.strictEqual(calls.length, TTS_CACHE_LIMIT, 'recent cache access should not call provider');

    await synthesizeSpeech({ user: { id: 'u-test' }, text: `lru text ${TTS_CACHE_LIMIT}`, voice: DEFAULT_VOICE });
    assert.strictEqual(calls.length, TTS_CACHE_LIMIT + 1);
    assert.deepStrictEqual(getTtsCacheStats(), { limit: TTS_CACHE_LIMIT, size: TTS_CACHE_LIMIT });

    await synthesizeSpeech({ user: { id: 'u-test' }, text: 'lru text 1', voice: DEFAULT_VOICE });
    assert.strictEqual(calls.length, TTS_CACHE_LIMIT + 2, 'least recently used entry should be evicted first');

    await synthesizeSpeech({ user: { id: 'u-test' }, text: 'lru text 0', voice: DEFAULT_VOICE });
    assert.strictEqual(calls.length, TTS_CACHE_LIMIT + 2, 'recently used entry should remain cached');
  });
}

async function main() {
  await assertCacheHitForSameTextVoiceAndFormat();
  await assertCacheKeyIncludesVoiceAndFormat();
  await assertLruEviction();
  console.log('assistant-tts-cache: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
