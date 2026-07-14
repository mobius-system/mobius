// 渲染层全局类型声明（登录页用 window.desktop；远程 web UI 用 window.mobiusDesktop）。
export interface DesktopApi {
  login: (c: { server: string; username: string; password: string }) => Promise<{ ok: boolean; error?: string }>;
  getLastServer: () => Promise<string>;
}

export interface AimuxStatus {
  state: "stopped" | "starting" | "connected" | "failed" | "disabled";
  detail?: string;
}

export interface AimuxDetails {
  status: AimuxStatus;
  aimuxEnabled: boolean;
  identifier: string;
  serverOrigin: string;
  aimuxVersion: string;
  venvDir: string;
  aimuxExe: string;
  aimuxLogPath: string;
  hasBundledPython: boolean;
  hostInfo: {
    platform: string;
    osVersion: string;
    arch: string;
    hostname: string;
    ips: string[];
    cpuModel: string;
    cpuCount: number;
    totalMemGB: number;
  };
  logs: string[];
}

export interface MobiusDesktopBridge {
  isDesktop: true;
  getBootData: () => Promise<{
    platform: string;
    osVersion: string;
    arch: string;
    hostname: string;
    ips: string[];
    cpuModel: string;
    cpuCount: number;
    totalMemGB: number;
    aimuxIdentifier: string;
    serverOrigin: string;
    appVersion: string;
  }>;
  getAimuxStatus: () => Promise<AimuxStatus>;
  getAimuxDetails: () => Promise<AimuxDetails>;
  getAimuxVersion: () => Promise<string>;
  reconnectAimux: () => Promise<{ ok: boolean; error?: string }>;
  getAimuxEnabled: () => Promise<boolean>;
  setAimuxEnabled: (enabled: boolean) => Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
  onAimuxStatus: (cb: (s: AimuxStatus) => void) => () => void;
  onAimuxLog: (cb: (line: string) => void) => () => void;
  updateAimux: () => Promise<{ ok: boolean; version?: string; error?: string }>;
  syncReload: () => Promise<void>;
  openStatusPanel: () => Promise<void>;
  openDevTools: () => Promise<void>;
  pickDirectory: () => Promise<string | null>;
  confirmProjectPath: (projectId: string, path: string) => Promise<{ ok: boolean; error?: string }>;
  getProjectLocalPath: (projectId: string) => Promise<string | null>;
  getProjectWorkMode: (projectId: string) => Promise<string | null>;
  setProjectWorkMode: (projectId: string, mode: string) => Promise<{ ok: boolean }>;
  listProjectLocalFiles: (projectId: string, path: string) => Promise<{
    ok: boolean;
    error?: string;
    bind_path?: string;
    path?: string;
    entries?: Array<{ name: string; type: "dir" | "file"; size: number | null; modified: string; abs_path: string }>;
  }>;
  readProjectLocalFile: (projectId: string, path: string) => Promise<{
    ok: boolean;
    error?: string;
    path?: string;
    name?: string;
    abs_path?: string;
    size?: number;
    content?: string;
    truncated?: boolean;
    binary?: boolean;
  }>;
  writeProjectLocalFile: (projectId: string, path: string, content: string) => Promise<{ ok: boolean; error?: string; saved?: boolean; size?: number }>;
  getMachineInfo: () => Promise<string>;
  logout: () => Promise<void>;
}

declare global {
  interface Window {
    desktop: DesktopApi;
    mobiusDesktop: MobiusDesktopBridge;
  }
}
