// 渲染层全局类型声明（登录页用 window.desktop；远程 web UI 用 window.mobiusDesktop）。
export interface DesktopApi {
  login: (c: { server: string; username: string; password: string }) => Promise<{ ok: boolean; error?: string }>;
  getLastServer: () => Promise<string>;
}

export interface AimuxStatus {
  state: "stopped" | "starting" | "connected" | "failed";
  detail?: string;
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
  onAimuxStatus: (cb: (s: AimuxStatus) => void) => () => void;
  updateAimux: () => Promise<{ ok: boolean; version?: string; error?: string }>;
  syncReload: () => Promise<void>;
  logout: () => Promise<void>;
}

declare global {
  interface Window {
    desktop: DesktopApi;
    mobiusDesktop: MobiusDesktopBridge;
  }
}
