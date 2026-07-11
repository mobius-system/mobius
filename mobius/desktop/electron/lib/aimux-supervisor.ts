// aimux reverse-connect 子进程的看护：启动 / 状态解析 / 断线重启 / JWT 到期续命 / 退出时杀干净。
import { spawn, type ChildProcess } from "node:child_process";

export type AimuxState = "stopped" | "starting" | "connected" | "failed";

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
    onStatus({ state: "starting", detail: "正在反向连接 mobius…", identifier });

    // aimux session.create 在 Windows 上会弹真实控制台窗口（这是它"被调度执行"的本意），
    // 故这里不强制 windowsHide；reverse connect 客户端进程本身不弹窗。
    const child = spawn(aimuxExe, ["reverse", "connect", bridgeUrl, "--identifier", identifier, "--token", token]);
    this.child = child;

    // 粗粒度解析日志推断状态（aimux 内部已带 5/10/20s×3 重连，重连耗尽会 exit → 我们 respawn）
    const classify = (line: string) => {
      this.opts.onLog?.(line);
      const lower = line.toLowerCase();
      if (/error|fail|refused|expired|invalid|traceback|exception/.test(lower)) {
        onStatus({ state: "failed", detail: line, identifier });
      } else if (/connected|registered|event stream|sse/i.test(lower)) {
        onStatus({ state: "connected", detail: line, identifier });
      }
    };
    const handle = (b: Buffer) => {
      for (const l of b.toString("utf8").split(/[\r\n]+/)) { const t = l.trim(); if (t) classify(t); }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);

    child.on("exit", (code) => {
      this.child = null;
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
