const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-admin-doubao-'));
process.env.DB_PATH = path.join(tempRoot, 'mobius.db');
process.env.MOBIUS_DATA_PATH = tempRoot;
process.env.CORE_DATA_PATH = tempRoot;
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json');
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace');

const adminSettings = require('../backend/services/admin-settings');
const doubaoTts = require('../backend/services/doubao-tts');
const doubaoAsr = require('../backend/services/doubao-asr');

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

function assertMaskedSecret(value, label) {
  assert.ok(value && typeof value === 'object', `${label} should be a masked object`);
  assert.ok(typeof value.isSet === 'boolean', `${label}.isSet should be boolean`);
  assert.ok(typeof value.preview === 'string', `${label}.preview should be string`);
}

function assertMaskedShape(masked) {
  assertMaskedSecret(masked.asr.appId, 'asr.appId');
  assertMaskedSecret(masked.asr.accessToken, 'asr.accessToken');
  assertMaskedSecret(masked.asr.secretKey, 'asr.secretKey');
  assert.strictEqual(typeof masked.asr.resourceId, 'string');
  assert.strictEqual(typeof masked.asr.endpoint, 'string');
  assertMaskedSecret(masked.tts.appId, 'tts.appId');
  assertMaskedSecret(masked.tts.accessToken, 'tts.accessToken');
  assertMaskedSecret(masked.tts.secretKey, 'tts.secretKey');
  assert.strictEqual(typeof masked.tts.resourceId, 'string');
  assert.strictEqual(typeof masked.tts.endpoint, 'string');
  assert.strictEqual(typeof masked.tts.voiceType, 'string');
}

function testMaskedRoundTrip() {
  const masked = adminSettings.setDoubaoVoiceTts({
    appId: 'app-id-xyz',
    accessToken: 'token-abcdef',
    secretKey: 'secret-1234',
    resourceId: 'custom-resource',
    endpoint: 'https://example.test/api/v3/tts/unidirectional',
    voiceType: 'zh_female_xiaohe_uranus_bigtts',
  });
  assertMaskedShape({ asr: masked, tts: masked });
  assert.strictEqual(masked.appId.isSet, true);
  assert.strictEqual(masked.appId.preview, '••••-xyz');
  assert.strictEqual(masked.accessToken.preview, '••••cdef');
  assert.strictEqual(masked.voiceType, 'zh_female_xiaohe_uranus_bigtts');
  assert.strictEqual(masked.resourceId, 'custom-resource');
}

function testRevealReturnsPlaintext() {
  const revealed = adminSettings.getDoubaoVoice();
  assert.strictEqual(revealed.tts.appId, 'app-id-xyz');
  assert.strictEqual(revealed.tts.accessToken, 'token-abcdef');
  assert.strictEqual(revealed.tts.secretKey, 'secret-1234');
}

function testAdminWinsOverEnv() {
  process.env.DOUBAO_TTS_APP_ID = 'env-app-id';
  process.env.DOUBAO_TTS_ACCESS_TOKEN = 'env-token';
  adminSettings.setDoubaoVoiceTts({ appId: 'admin-app-id', accessToken: 'admin-token' });
  const creds = doubaoTts.resolveCredentials();
  assert.strictEqual(creds.appId, 'admin-app-id');
  assert.strictEqual(creds.accessToken, 'admin-token');
}

function testEnvFallbackWhenAdminEmpty() {
  adminSettings.setDoubaoVoiceTts({ appId: '', accessToken: '' });
  const creds = doubaoTts.resolveCredentials();
  assert.strictEqual(creds.appId, 'env-app-id');
  assert.strictEqual(creds.accessToken, 'env-token');
}

function testPerCardIsolation() {
  adminSettings.setDoubaoVoiceAsr({ appId: 'asr-only', accessToken: 'asr-tok' });
  const revealed = adminSettings.getDoubaoVoice();
  assert.strictEqual(revealed.asr.appId, 'asr-only');
  // TTS values from earlier tests should be untouched by ASR write
  assert.strictEqual(revealed.tts.appId, '');
}

function testRejectsBadEndpoint() {
  assert.throws(
    () => adminSettings.setDoubaoVoiceAsr({ endpoint: 'https://wrong.proto.for.asr' }),
    /wss:\/\//,
  );
  assert.throws(
    () => adminSettings.setDoubaoVoiceTts({ endpoint: 'wss://wrong.proto.for.tts' }),
    /https:\/\//,
  );
}

function testAsrResolvePrefersAdmin() {
  adminSettings.setDoubaoVoiceAsr({ appId: 'asr-final', accessToken: 'asr-final-tok' });
  process.env.DOUBAO_ASR_APP_ID = 'env-asr';
  process.env.DOUBAO_ASR_ACCESS_TOKEN = 'env-asr-tok';
  const creds = doubaoAsr.resolveCredentials();
  assert.strictEqual(creds.appId, 'asr-final');
  assert.strictEqual(creds.accessToken, 'asr-final-tok');
}

function testResolveFromPayload() {
  const fromPayload = doubaoTts.resolveCredentialsFromPayload({
    appId: 'p-app',
    accessToken: 'p-tok',
    endpoint: 'https://custom.example/api/v3/tts/unidirectional',
  });
  assert.strictEqual(fromPayload.appId, 'p-app');
  assert.strictEqual(fromPayload.accessToken, 'p-tok');
  assert.strictEqual(fromPayload.endpoint, 'https://custom.example/api/v3/tts/unidirectional');
  assert.strictEqual(fromPayload.resourceId, 'seed-tts-2.0');
}

function testMaskedReadAfterClear() {
  adminSettings.setDoubaoVoiceTts({ appId: '', accessToken: '', secretKey: '' });
  const masked = adminSettings.getDoubaoVoiceMasked();
  assert.strictEqual(masked.tts.appId.isSet, false);
  assert.strictEqual(masked.tts.appId.preview, '');
}

function main() {
  testMaskedRoundTrip();
  testRevealReturnsPlaintext();
  testAdminWinsOverEnv();
  testEnvFallbackWhenAdminEmpty();
  testPerCardIsolation();
  testRejectsBadEndpoint();
  testAsrResolvePrefersAdmin();
  testResolveFromPayload();
  testMaskedReadAfterClear();
  console.log('admin-doubao-voice: ok');
}

main();
