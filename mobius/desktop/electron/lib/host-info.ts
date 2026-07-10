// 采集本机环境信息，经 preload bridge 暴露给远程 web UI 的 desktop 模式展示。
import * as os from "node:os";

export interface BootData {
  platform: NodeJS.Platform;
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
}

export function gatherHostInfo(opts: {
  aimuxIdentifier: string;
  serverOrigin: string;
  appVersion: string;
}): BootData {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // 只收非内网回环的 IPv4，足够"本机 IP"展示用途
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  const cpus = os.cpus();
  return {
    platform: process.platform,
    osVersion: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    ips,
    cpuModel: cpus[0]?.model || "unknown",
    cpuCount: cpus.length,
    totalMemGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    aimuxIdentifier: opts.aimuxIdentifier,
    serverOrigin: opts.serverOrigin,
    appVersion: opts.appVersion,
  };
}
