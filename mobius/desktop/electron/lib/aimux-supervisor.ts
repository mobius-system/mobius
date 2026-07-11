// aimux reverse-connect 子进程的看护：启动 / 状态解析 / 断线重启 / JWT 到期续命 / 退出时杀干净。
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// disabled：用户手动关闭了 aimux 反连（区别于 stopped=未启动/已停止、failed=连接失败）。
// supervisor 自身不会产生 disabled，只有 main 进程在用户切换开关时设置。
export type AimuxState = "stopped" | "starting" | "connected" | "failed" | "disabled";

export interface AimuxStatus {
  state: AimuxState;
  detail?: string;
  identifier?: string;
}

export interface SupervisorOptions {
  aimuxExe: string;
  /** ${server}/aimux_bridge — aimux reverse connect 的目标 URL */
  bridgeUrl: string;
  /** mobius JWT，作为 reverse connect 的 --token */
  token: string;
  identifier: string;
  /** 状态变化回调（主进程用来更新徽标 + 推给 web UI） */
  onStatus: (s: AimuxStatus) => void;
  /** 每行 stdout/stderr 日志回调（主进程进环形缓冲供状态面板查看） */
  onLog?: (line: string) => void;
  /** JWT 即将到期时主进程据此重登，返回新 token 或 null */
  onTokenExpired: () => Promise<string | null>;
}

export function aimuxLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "aimux.log");
}

export function appendAimuxLog(data: string | Buffer): void {
  const logPath = aimuxLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, data);
  } catch (e) {
    console.error(`[aimux-supervisor] 写 aimux 日志失败 (${logPath}):`, e);
  }
}

export class AimuxSupervisor {
  private child: ChildProcess | null = null;
  private stopping = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private opts: SupervisorOptions;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopping = false;
    this.spawnChild();
    this.scheduleTokenRefresh();
  }

  private spawnChild(): void {
    const { aimuxExe, bridgeUrl, token, identifier, onStatus } = this.opts;
    onStatus({ state: "starting", detail: "正在连接 mobius…", identifier });

    appendAimuxLog(`\n==== [${new Date().toISOString()}] spawn reverse connect identifier=${identifier} ====\n`);
    const child = spawn(aimuxExe, ["reverse", "connect", bridgeUrl, "--identifier", identifier, "--token", token, "--replace"]);
    this.child = child;

    // 粗粒度解析日志推断状态（aimux 内部已带 5/10/20s×3 重连，重连耗尽会 exit → 我们 respawn）
    const classify = (line: string) => {
      this.opts.onLog?.(line);
      const lower = line.toLowerCase();
      // 命令执行失败 (如 send_keys 到不存在的 session) 不是连接失败 — bridge 仍连着, 只是某条命令报错.
      // aimux 日志特征: 含 "command failed" 或 "request_id=". 跳过, 不改连接状态, 避免误标 failed.
      if (/command failed|request_id=/.test(lower)) return;
      if (/error|fail|refused|expired|invalid|traceback|exception/.test(lower)) {
        onStatus({ state: "failed", detail: line, identifier });
      } else if (/connected|registered|event stream|sse/i.test(lower)) {
        onStatus({ state: "connected", detail: line, identifier });
      }
    };
    const handle = (b: Buffer) => {
      appendAimuxLog(b);
      for (const l of b.toString("utf8").split(/[\r\n]+/)) { const t = l.trim(); if (t) classify(t); }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);

    child.on("exit", (code) => {
      this.child = null;
      appendAimuxLog(`\n---- [${new Date().toISOString()}] child exited code=${code} ----\n`);
      if (this.stopping) {
        this.opts.onStatus({ state: "stopped", identifier });
        return;
      }
      this.opts.onStatus({ state: "failed", detail: `aimux 退出 code=${code}，5s 后重启`, identifier });
      this.respawnTimer = setTimeout(() => {
        if (!this.stopping) this.spawnChild();
      }, 5000);
    });
    child.on("error", (err) => {
      appendAimuxLog(`\n---- [${new Date().toISOString()}] spawn error: ${err.message} ----\n`);
      this.opts.onStatus({ state: "failed", detail: `spawn 失败: ${err.message}`, identifier });
    });
  }

  /** 用新 token 重启（JWT 续期后调用）。 */
  async restartWithToken(token: string): Promise<void> {
    this.opts = { ...this.opts, token };
    await this.killChild();
    if (!this.stopping) this.spawnChild();
  }

  /** 解析 JWT exp，提前 10 分钟触发续期。 */
  private scheduleTokenRefresh(): void {
    try {
      const payload = JSON.parse(Buffer.from(this.opts.token.split(".")[1], "base64").toString("utf8"));
      const expMs = (payload.exp || 0) * 1000;
      const refreshAt = expMs - 10 * 60 * 1000;
      const delay = Math.max(60_000, refreshAt - Date.now());
      this.refreshTimer = setTimeout(() => void this.refreshToken(), delay);
    } catch {
      /* token 非 JWT 或解析失败 → 不自动续期，到期后 aimux 会失败并由 respawn 循环暴露 */
    }
  }

  private async refreshToken(): Promise<void> {
    if (this.stopping) return;
    const newToken = await this.opts.onTokenExpired();
    if (newToken) {
      await this.restartWithToken(newToken);
      this.scheduleTokenRefresh();
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child?.pid) {
      this.child = null;
      return;
    }
    if (process.platform === "win32") {
      // Windows: SIGTERM 不可靠，aimux 还会派生 pty/console 子进程 → taskkill /T 连树一起杀。
      // detached + unref：即使父进程(app)紧接着退出，taskkill 仍独立运行把 aimux 杀干净。
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        });
        killer.on("close", () => resolve());
        killer.on("error", () => resolve());
        killer.unref();
      });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.child = null;
  }

  /** 应用退出前必须调用：杀进程 + 清定时器，避免 aimux 残留继续连服务器。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.killChild();
    this.opts.onStatus({ state: "stopped", identifier: this.opts.identifier });
  }
}
