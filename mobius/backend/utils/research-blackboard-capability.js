const crypto = require('crypto');

const RESEARCH_BLACKBOARD_CLI_TOKEN_HEADER = 'x-mobius-research-cli-token';
const TOKEN_PREFIX = 'mrb2';
const TOKEN_VERSION = 2;
const TOKEN_SCOPE = 'research-blackboard-cli';
const TOKEN_TTL_SECONDS = 60;
const MAX_TOKEN_LIFETIME_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 15;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signEncodedPayload(secret, encoded) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(`research-blackboard-cli:v2:${encoded}`)
    .digest('base64url');
}

function createResearchBlackboardCliToken(secret, input, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('JWT_SECRET is required');
  const action = input && input.action;
  const sessionRef = String(input && input.sessionRef || '').trim();
  const researchId = String(input && input.researchId || '').trim();
  const receiverRef = String(input && input.receiverRef || '').trim();
  const limitedReceiver = input && input.limitedReceiver === true;
  if (action !== 'read' && action !== 'write') throw new Error('action must be read or write');
  if (!ID_RE.test(sessionRef)) throw new Error('sessionRef is invalid');
  if (!ID_RE.test(researchId)) throw new Error('researchId is invalid');
  if (limitedReceiver && action !== 'write') throw new Error('limitedReceiver is only valid for write');
  if (limitedReceiver && !ID_RE.test(receiverRef)) throw new Error('receiverRef is required for limited write');
  if (!limitedReceiver && receiverRef) throw new Error('receiverRef requires limitedReceiver');
  const iat = Number(nowSeconds);
  const payload = {
    v: TOKEN_VERSION,
    scope: TOKEN_SCOPE,
    action,
    session_ref: sessionRef,
    research_id: researchId,
    limited_receiver: limitedReceiver,
    ...(receiverRef ? { receiver_ref: receiverRef } : {}),
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  };
  const encoded = encodePayload(payload);
  return `${TOKEN_PREFIX}.${encoded}.${signEncodedPayload(secret, encoded)}`;
}

function safeSignatureEqual(actual, expected) {
  try {
    const a = Buffer.from(String(actual || ''), 'base64url');
    const b = Buffer.from(String(expected || ''), 'base64url');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function verifyResearchBlackboardCliToken(token, secret, expected = {}, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !secret) return null;
  const encoded = parts[1];
  if (!encoded || !safeSignatureEqual(parts[2], signEncodedPayload(secret, encoded))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const now = Number(nowSeconds);
    if (payload?.v !== TOKEN_VERSION || payload?.scope !== TOKEN_SCOPE) return null;
    if (payload.action !== 'read' && payload.action !== 'write') return null;
    if (!ID_RE.test(String(payload.session_ref || '')) || !ID_RE.test(String(payload.research_id || ''))) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) return null;
    if (payload.iat > now + CLOCK_SKEW_SECONDS || payload.exp < now - CLOCK_SKEW_SECONDS) return null;
    if (payload.limited_receiver !== true && payload.limited_receiver !== false) return null;
    if (payload.limited_receiver) {
      if (payload.action !== 'write' || !ID_RE.test(String(payload.receiver_ref || ''))) return null;
    } else if (payload.receiver_ref) {
      return null;
    }
    if (expected.action && payload.action !== expected.action) return null;
    if (expected.researchId && payload.research_id !== expected.researchId) return null;
    return {
      action: payload.action,
      sessionRef: payload.session_ref,
      researchId: payload.research_id,
      limitedReceiver: payload.limited_receiver,
      receiverRef: payload.receiver_ref || null,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

module.exports = {
  CLOCK_SKEW_SECONDS,
  ID_RE,
  MAX_TOKEN_LIFETIME_SECONDS,
  RESEARCH_BLACKBOARD_CLI_TOKEN_HEADER,
  TOKEN_TTL_SECONDS,
  createResearchBlackboardCliToken,
  verifyResearchBlackboardCliToken,
};
