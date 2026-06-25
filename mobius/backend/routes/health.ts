import express from 'express';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
// @ts-ignore — bridge instance 仍是 .js
import { bridge } from '../bridge/instance';

const router = express.Router();

router.get('/', (_req: express.Request, res: express.Response) => {
  res.json({ status: 'ok', agent_backend: bridge.isConnected(), timestamp: new Date().toISOString() });
});

// ── 服务器内存占用 ──
// 约束: 真实读取频率不得超过每分钟 1 次。
// 这里用模块级 60s 缓存兜底: 无论多少前端 / 标签页并发轮询,
// /proc/meminfo 实际最多每 60s 被读取一次。
const MEM_CACHE_TTL_MS = 60 * 1000;
let memCache: { ts: number; payload: any } = { ts: 0, payload: null };
const DISK_CACHE_TTL_MS = 60 * 1000;
const DISK_SAMPLE_PATH = process.env.MOBIUS_DISK_SAMPLE_PATH || '/';
let diskCache: { ts: number; payload: any } = { ts: 0, payload: null };

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function bytesToGb(bytes: number): number {
  return round1(bytes / 1073741824);
}

interface MemUsage {
  totalMb: number;
  usedMb: number;
  availMb: number;
  usedPercent: number;
}

function readMemoryUsage(): MemUsage {
  // 优先用 /proc/meminfo 的 MemAvailable (计入可回收的 buffer/cache, 最贴近真实可用内存)
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k: string): number | null => {
      const m = info.match(new RegExp('^' + k + ':\\s+(\\d+)\\s*kB', 'm'));
      return m ? parseInt(m[1], 10) * 1024 : null;
    };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    if (total && avail != null) {
      const used = total - avail;
      return {
        totalMb: Math.round(total / 1048576),
        usedMb: Math.round(used / 1048576),
        availMb: Math.round(avail / 1048576),
        usedPercent: Math.round((used / total) * 1000) / 10,
      };
    }
  } catch { /* 读取失败则回退到 os 模块 */ }
  // 兜底: os 模块 (freemem 不含 buffer/cache, 占用率偏高但始终可用)
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalMb: Math.round(total / 1048576),
    usedMb: Math.round(used / 1048576),
    availMb: Math.round(free / 1048576),
    usedPercent: Math.round((used / total) * 1000) / 10,
  };
}

router.get('/memory', (_req: express.Request, res: express.Response) => {
  const now = Date.now();
  const fresh = !memCache.payload || now - memCache.ts >= MEM_CACHE_TTL_MS;
  if (fresh) {
    memCache = {
      ts: now,
      payload: { ...readMemoryUsage(), sampledAt: new Date(now).toISOString() },
    };
  }
  res.json({ ...memCache.payload, cached: !fresh });
});

// ── 系统主盘占用 ──
// 以根目录所在文件系统作为系统主盘。优先用 statfs 读取, 回退到 POSIX df。
// 与内存端点一样使用模块级 60s 缓存, 避免多标签页并发时频繁采样。
function diskPercent(usedBytes: number, availBytes: number, totalBytes: number): number {
  const basis = (usedBytes + availBytes) > 0 ? usedBytes + availBytes : totalBytes;
  if (!basis) return 0;
  return round1((usedBytes / basis) * 100);
}

interface DiskUsage {
  totalGb: number;
  usedGb: number;
  availGb: number;
  usedPercent: number;
  targetPath: string;
  mountPath: string;
  source: string;
}

function shapeDiskUsage(args: {
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  targetPath: string;
  mountPath: string;
  source: string;
}): DiskUsage {
  return {
    totalGb: bytesToGb(args.totalBytes),
    usedGb: bytesToGb(args.usedBytes),
    availGb: bytesToGb(args.availBytes),
    usedPercent: diskPercent(args.usedBytes, args.availBytes, args.totalBytes),
    targetPath: args.targetPath,
    mountPath: args.mountPath,
    source: args.source,
  };
}

function readDiskUsageWithStatfs(): DiskUsage {
  const anyFs = fs as any;
  if (typeof anyFs.statfsSync !== 'function') throw new Error('statfsSync unavailable');
  const stat = anyFs.statfsSync(DISK_SAMPLE_PATH);
  const blockSize = Number(stat.bsize || stat.frsize || 0);
  const totalBlocks = Number(stat.blocks);
  const freeBlocks = Number(stat.bfree);
  const availBlocks = Number(stat.bavail);
  if (!blockSize || !totalBlocks || !Number.isFinite(freeBlocks) || !Number.isFinite(availBlocks)) {
    throw new Error('invalid statfs result');
  }
  const totalBytes = totalBlocks * blockSize;
  const usedBytes = Math.max(0, (totalBlocks - freeBlocks) * blockSize);
  const availBytes = Math.max(0, availBlocks * blockSize);
  return shapeDiskUsage({
    totalBytes,
    usedBytes,
    availBytes,
    targetPath: DISK_SAMPLE_PATH,
    mountPath: DISK_SAMPLE_PATH,
    source: 'statfs',
  });
}

function readDiskUsageWithDf(): DiskUsage {
  const out = execFileSync('df', ['-kP', DISK_SAMPLE_PATH], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  }).trim();
  const lines = out.split(/\n/).filter(Boolean);
  const fields = lines[lines.length - 1]?.trim().split(/\s+/) || [];
  if (fields.length < 6) throw new Error('invalid df result');
  const totalKb = Number(fields[1]);
  const usedKb = Number(fields[2]);
  const availKb = Number(fields[3]);
  if (!totalKb || !Number.isFinite(usedKb) || !Number.isFinite(availKb)) {
    throw new Error('invalid df numbers');
  }
  return shapeDiskUsage({
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    availBytes: availKb * 1024,
    targetPath: DISK_SAMPLE_PATH,
    mountPath: fields.slice(5).join(' '),
    source: 'df',
  });
}

function readDiskUsage(): DiskUsage {
  try {
    return readDiskUsageWithStatfs();
  } catch {
    return readDiskUsageWithDf();
  }
}

router.get('/disk', (_req: express.Request, res: express.Response) => {
  const now = Date.now();
  const fresh = !diskCache.payload || now - diskCache.ts >= DISK_CACHE_TTL_MS;
  if (fresh) {
    try {
      diskCache = {
        ts: now,
        payload: { ...readDiskUsage(), sampledAt: new Date(now).toISOString() },
      };
    } catch {
      if (!diskCache.payload) {
        res.status(500).json({ error: '磁盘采样失败' });
        return;
      }
      res.json({ ...diskCache.payload, cached: true, stale: true });
      return;
    }
  }
  res.json({ ...diskCache.payload, cached: !fresh });
});

export = router;
