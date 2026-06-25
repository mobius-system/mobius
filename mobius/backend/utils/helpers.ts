import fs from 'fs';
import path from 'path';
import { TEST_ROOT } from '../config';

function nowIso(): string {
  return new Date().toISOString();
}

function currentBaseRevision(): string {
  try {
    const gitHead = path.join(TEST_ROOT, '.git', 'HEAD');
    if (fs.existsSync(gitHead)) {
      const head = fs.readFileSync(gitHead, 'utf8').trim();
      if (head.startsWith('ref:')) {
        const refPath = path.join(TEST_ROOT, '.git', head.replace('ref:', '').trim());
        if (fs.existsSync(refPath)) return `test-main@${fs.readFileSync(refPath, 'utf8').trim().slice(0, 12)}`;
      }
      if (head) return `test-main@${head.slice(0, 12)}`;
    }
  } catch {}
  return `test-main@${nowIso()}`;
}

function normalizeChangedFile(filePath: unknown): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  let p: string = filePath.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!p) return null;
  p = p.replace(/\\/g, '/');
  p = p.replace(/^\/home\/user\/imac-test\//, '');
  p = p.replace(/^imac-test\//, '');
  p = p.replace(/^\.\//, '');
  if (p.includes('..') || p.startsWith('/')) return null;
  if (!p || p.length > 220) return null;
  return p;
}

type FileRisk = 'schema' | 'config' | 'high' | 'medium' | 'low';

function fileRisk(filePath: string): FileRisk {
  if (/(^|\/)(db\.js|schema|migration)/i.test(filePath)) return 'schema';
  if (/config|\.toml$|\.env|gateway-manager\.sh|package(-lock)?\.json$/i.test(filePath)) return 'config';
  if (/server\.js$|bridge-client\.js$/.test(filePath)) return 'high';
  if (/frontend\/src\//.test(filePath)) return 'medium';
  return 'low';
}

interface ConflictKind {
  type: 'schema' | 'config' | 'same_symbol' | 'same_file';
  severity: 'blocking' | 'warn';
}

function conflictId(leftId: string, rightId: string, filePath: string): string {
  const [a, b] = [leftId, rightId].sort();
  return `${a}:${b}:${Buffer.from(filePath).toString('base64url').slice(0, 32)}`;
}

function conflictKind(filePath: string, risk: FileRisk): ConflictKind {
  if (risk === 'schema') return { type: 'schema', severity: 'blocking' };
  if (risk === 'config') return { type: 'config', severity: 'blocking' };
  if (/server\.js$|db\.js$/.test(filePath)) return { type: 'same_symbol', severity: 'blocking' };
  return { type: 'same_file', severity: 'warn' };
}

type PermissionContent = 'allow' | 'deny' | 'allow all' | '';

function permissionContentFromValue(value: unknown): PermissionContent {
  switch (String(value || '').trim()) {
    case 'perm:allow':
    case 'allow':
      return 'allow';
    case 'perm:deny':
    case 'deny':
      return 'deny';
    case 'perm:allow_all':
    case 'allow_all':
    case 'allow all':
      return 'allow all';
    default:
      return '';
  }
}

function extractTaskId(sessionKey: string | null | undefined): string {
  // web:userId:taskId → taskId
  const parts = (sessionKey || '').split(':');
  return parts.length >= 3 ? parts[2] : (sessionKey || '');
}

export {
  nowIso,
  currentBaseRevision,
  normalizeChangedFile,
  fileRisk,
  conflictId,
  conflictKind,
  permissionContentFromValue,
  extractTaskId,
};

export type { FileRisk, ConflictKind, PermissionContent };
