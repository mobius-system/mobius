import { app } from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pidAlive, pickSilentFlag, pickEnableGuiFlag, pickGuiNoElevateFlag, pickGuiArgs, reverseConnectArgs, type GuiMode } from "../../../tui/src/lib/aimux-protocol";
import { windowsElevated } from "../../../tui/src/lib/windows-admin";

export type AimuxState = "stopped" | "starting" | "connected" | "failed" | "disabled";
export interface AimuxStatus { state: AimuxState; detail?: string; identifier?: string }
export interface BridgeProbe { connected: boolean; authError: boolean }
export interface SupervisorOptions {
  aimuxExe: string;
  bridgeUrl: string;
  token: string;
  identifier: string;
  onStatus: (s: AimuxStatus) => void;
  onLog?: (line: string) => void;
  probeBridgeConnection: () => Promise<BridgeProbe>;
  onTokenExpired: () => Promise<string | null>;
  runtimePath: string;
  guiMode?: GuiMode;
  watchdogTimeoutSeconds?: number;
  heartbeatIntervalMs?: number;
  spawnGraceMs?: number;
}
interface RuntimeRecord {
  pid?: number;
  identifier?: string;
  last_feed_watchdog?: number;
  need_external_restart?: boolean;
  realtime_healthy_display?: boolean;
}

export function aimuxLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "aimux.log");
}
export function appendAimuxLog(data: string | Buffer): void {
  try {
    fs.mkdirSync(path.dirname(aimuxLogPath()), { recursive: true });
    fs.appendFileSync(aimuxLogPath(), data);
  } catch (e) { console.error("[aimux-supervisor] log write failed", e); }
}

/*
 * Feed a detached daemon while the desktop is alive. A bridge outage never
 * kills a live daemon: AIMUX owns transport reconnection, as it does in TUI.
 */
export class AimuxSupervisor {
  private stopping = true;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private spawnedPid: number | undefined;
  private spawnedAt = 0;
  private attempts = 0;
  private help = "";
  private lastRefresh = 0;
  private refreshAt = Infinity;
  private lastStatus = "";

  constructor(private opts: SupervisorOptions) {}

  private readRuntime(): RuntimeRecord {
    try { return JSON.parse(fs.readFileSync(this.opts.runtimePath, "utf8")); } catch { return {}; }
  }

  private updateRuntime(patch: Partial<RuntimeRecord>): void {
    fs.mkdirSync(path.dirname(this.opts.runtimePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.runtimePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...this.readRuntime(), ...patch }), { mode: 0o600 });
    fs.renameSync(tmp, this.opts.runtimePath);
  }

  private status(state: AimuxState, detail: string): void {
    const key = `${state}:${detail}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.opts.onStatus({ state, detail, identifier: this.opts.identifier });
  }

  private log(line: string): void {
    appendAimuxLog(`[${new Date().toISOString()}] ${line}\n`);
    this.opts.onLog?.(line);
  }

  private async probeHelp(): Promise<string> {
    return new Promise(resolve => {
      const child = spawn(this.opts.aimuxExe, ["reverse", "connect", "--help"], { windowsHide: true });
      let output = "";
      const timer = setTimeout(() => { child.kill(); resolve(""); }, 8000);
      child.stdout?.on("data", b => { output += b.toString(); });
      child.stderr?.on("data", b => { output += b.toString(); });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(output); });
    });
  }

  private scheduleRefresh(): void {
    try {
      const { exp } = JSON.parse(Buffer.from(this.opts.token.split(".")[1], "base64").toString());
      this.refreshAt = typeof exp === "number" ? exp * 1000 - 600_000 : Infinity;
    } catch { this.refreshAt = Infinity; }
  }

  async start(): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    const epoch = ++this.epoch;
    this.status("starting", "检查 AIMUX 命令与守护进程…");
    try {
      this.help = await this.probeHelp();
      if (this.stopping || epoch !== this.epoch) return;
      this.scheduleRefresh();
      this.feedWatchdog();
      this.watchdogTimer = setInterval(() => this.feedWatchdog(), 5000);
      this.ensureDaemon();
      await this.check(epoch);
    } catch (e) {
      if (!this.stopping) {
        this.clearTimers();
        this.stopping = true;
        this.status("failed", `AIMUX 启动失败: ${(e as Error).message}`);
      }
    }
  }

  private feedWatchdog(): void {
    if (this.stopping) return;
    try { this.updateRuntime({ last_feed_watchdog: Date.now() }); }
    catch (e) { this.log(`watchdog write failed: ${(e as Error).message}`); }
  }

  private daemonPid(): number | undefined {
    const recorded = this.readRuntime().pid;
    if (recorded && pidAlive(recorded)) return recorded;
    return this.spawnedPid && pidAlive(this.spawnedPid) ? this.spawnedPid : undefined;
  }

  private ensureDaemon(): void {
    if (this.stopping || this.daemonPid()) return;
    if (this.spawnedAt && Date.now() - this.spawnedAt < (this.opts.spawnGraceMs ?? 90_000)) return;
    if (this.attempts >= 3) {
      this.status("failed", `AIMUX 连续 3 次启动失败，请查看日志: ${aimuxLogPath()}`);
      return;
    }
    const gui = pickGuiArgs(this.opts.guiMode ?? "off", windowsElevated(), {
      enable: pickEnableGuiFlag(this.help), noElevate: pickGuiNoElevateFlag(this.help),
    });
    const args = reverseConnectArgs(
      this.opts.bridgeUrl.replace(/\/aimux_bridge\/?$/, ""), this.opts.identifier, this.opts.token,
      process.platform, pickSilentFlag(this.help), this.opts.runtimePath, gui.enableGui, gui.guiNoElevate,
    );
    if (/--watchdog-timeout\b/.test(this.help)) args.push("--watchdog-timeout", String(this.opts.watchdogTimeoutSeconds ?? 30));
    this.updateRuntime({ need_external_restart: false, realtime_healthy_display: false });
    fs.mkdirSync(path.dirname(aimuxLogPath()), { recursive: true });
    const fd = fs.openSync(aimuxLogPath(), "a", 0o600);
    try {
      // 由 watchdog 决定守护进程寿命，输出直接落盘，避免退出后管道断裂。✨
      // Let the watchdog own daemon lifetime and log to disk to avoid broken pipes after exit. ✨
      const child = spawn(this.opts.aimuxExe, args, { detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
      this.spawnedPid = child.pid;
      this.spawnedAt = Date.now();
      this.attempts += 1;
      child.on("error", e => this.log(`AIMUX spawn failed: ${e.message}`));
      child.unref();
      this.log(`AIMUX daemon started identifier=${this.opts.identifier} pid=${child.pid ?? "unknown"} attempt=${this.attempts}`);
      this.status("starting", "等待 AIMUX bridge 心跳确认…");
    } finally { fs.closeSync(fd); }
  }

  private async check(epoch: number): Promise<void> {
    try {
      const probe = await this.opts.probeBridgeConnection().catch(() => ({ connected: false, authError: false }));
      if (this.stopping || epoch !== this.epoch) return;
      if ((probe.authError || Date.now() >= this.refreshAt) && Date.now() - this.lastRefresh >= 60_000) {
        this.lastRefresh = Date.now();
        this.status("starting", "正在刷新 AIMUX 登录凭据…");
        const token = await this.opts.onTokenExpired().catch(() => null);
        if (this.stopping || epoch !== this.epoch) return;
        if (token) {
          this.opts.token = token;
          this.scheduleRefresh();
          await this.killDaemon();
          if (this.stopping || epoch !== this.epoch) return;
          this.attempts = 0;
          this.spawnedAt = 0;
          this.ensureDaemon();
        } else this.status("failed", "AIMUX 登录凭据刷新失败，将自动重试");
      } else if (probe.connected) {
        this.attempts = 0;
        this.updateRuntime({ realtime_healthy_display: true });
        this.status("connected", "bridge 已确认当前反向连接在线");
      } else {
        this.updateRuntime({ realtime_healthy_display: false });
        this.status("starting", probe.authError ? "等待刷新 AIMUX 登录凭据…" : "等待 AIMUX 自动恢复连接…");
        if (!probe.authError) this.ensureDaemon();
      }
    } catch (e) { this.status("failed", `AIMUX 心跳失败: ${(e as Error).message}`); }
    finally {
      if (!this.stopping && epoch === this.epoch) {
        this.timer = setTimeout(() => void this.check(epoch), this.opts.heartbeatIntervalMs ?? 5000);
      }
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.timer = null;
    this.watchdogTimer = null;
  }

  private async killDaemon(): Promise<void> {
    const pid = this.daemonPid();
    if (pid) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          child.on("error", reject);
          child.on("close", () => resolve());
        });
      } else {
        try { process.kill(pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      }
      for (let n = 0; n < 30 && pidAlive(pid); n++) await new Promise(r => setTimeout(r, 100));
      if (pidAlive(pid)) {
        if (process.platform === "win32") throw new Error("AIMUX 进程仍在退出中，请稍后重试");
        process.kill(pid, "SIGKILL");
        for (let n = 0; n < 10 && pidAlive(pid); n++) await new Promise(r => setTimeout(r, 100));
        if (pidAlive(pid)) throw new Error("AIMUX 进程无法停止");
      }
    }
    this.spawnedPid = undefined;
    fs.rmSync(this.opts.runtimePath, { force: true });
  }

  /*
   * Normal app exit only ends the lease, matching TUI. Explicit disable,
   * logout, upgrade and reconnect stop the daemon before changing its inputs.
   */
  async stop(terminate = true): Promise<void> {
    this.stopping = true;
    this.epoch += 1;
    this.clearTimers();
    if (terminate) await this.killDaemon();
    this.status("stopped", terminate ? "AIMUX 已停止" : "AIMUX watchdog 将在续租超时后停止");
  }
}
