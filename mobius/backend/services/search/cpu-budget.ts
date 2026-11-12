import fs from 'fs';
import { fork, type ChildProcess } from 'child_process';

export function cpuBudgetExceeded(cpuMs: number): boolean {
  return cpuMs >= 30;
}

export function limitIndexerCpu(child: ChildProcess): void {
  if (process.platform !== 'linux') throw new Error('Search CPU limiter requires Linux /proc');
  const monitor = fork(__filename, ['--monitor-indexer', String(child.pid)], {
    execArgv: ['--require', require.resolve('tsx/cjs')], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.once('exit', () => monitor.kill());
}

function monitorCpu(pid: number): void {
  let baseline: number | null = null;
  let windowStarted = performance.now();
  let stopped = false;
  const timer = setInterval(() => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]);
      const now = performance.now();
      if (baseline === null || now - windowStarted >= 1000) {
        baseline = ticks;
        windowStarted = now;
        if (stopped) { process.kill(pid, 'SIGCONT'); stopped = false; }
      } else if (!stopped && cpuBudgetExceeded((ticks - baseline) * 10)) {
        process.kill(pid, 'SIGSTOP');
        stopped = true;
      }
    } catch { process.exit(0); }
  }, 10);
  const cleanup = () => { try { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGTERM'); } catch {} };
  process.once('disconnect', () => { clearInterval(timer); cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { clearInterval(timer); cleanup(); process.exit(0); });
}

if (process.argv[2] === '--monitor-indexer') monitorCpu(Number(process.argv[3]));
