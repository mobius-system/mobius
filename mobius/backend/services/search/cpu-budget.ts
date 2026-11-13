import fs from 'fs';
import os from 'os';
import path from 'path';

export function effectiveCpuCount(): number {
  let count = os.availableParallelism?.() || os.cpus().length;
  const roots = new Set(['/sys/fs/cgroup']);
  try {
    const group = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (group) {
      let directory = path.join('/sys/fs/cgroup', group);
      while (directory.startsWith('/sys/fs/cgroup/')) {
        roots.add(directory);
        directory = path.dirname(directory);
      }
    }
  } catch {}
  for (const directory of roots) {
    try {
      const [quota, period] = fs.readFileSync(path.join(directory, 'cpu.max'), 'utf8').trim().split(/\s+/);
      if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) count = Math.min(count, Number(quota) / Number(period));
    } catch {}
  }
  return count;
}

export const SEARCH_CPU_COUNT = effectiveCpuCount();
export const SEARCH_CPU_FRACTION = 0.35;

export function cpuRestMs(cpuMs: number, elapsedMs: number, cpuCount = SEARCH_CPU_COUNT): number {
  return Math.max(0, Math.ceil(cpuMs / (cpuCount * SEARCH_CPU_FRACTION) - elapsedMs));
}
