import fs from 'fs';
import type { ChildProcess } from 'child_process';

export function cpuBudgetExceeded(cpuMs: number): boolean {
  return cpuMs >= 70;
}

export function limitIndexerCpu(child: ChildProcess): void {
  if (process.platform !== 'linux') throw new Error('Search CPU limiter requires Linux /proc');
  let baseline: number | null = null;
  let windowStarted = performance.now();
  let stopped = false;
  const timer = setInterval(() => {
    try {
      const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]);
      const now = performance.now();
      if (baseline === null || now - windowStarted >= 1000) {
        baseline = ticks;
        windowStarted = now;
        if (stopped) { child.kill('SIGCONT'); stopped = false; }
      } else if (!stopped && cpuBudgetExceeded((ticks - baseline) * 10)) {
        child.kill('SIGSTOP');
        stopped = true;
      }
    } catch {}
  }, 10);
  timer.unref();
  const cleanup = () => { try { child.kill('SIGCONT'); child.kill(); } catch {} };
  child.once('exit', () => { clearInterval(timer); process.removeListener('exit', cleanup); });
  process.once('exit', cleanup);
}
