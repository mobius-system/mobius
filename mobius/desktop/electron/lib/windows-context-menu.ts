import { spawnSync } from "node:child_process";

const MENU_KEY = "HKCU\\Software\\Classes\\Directory\\shell\\MobiusDesktop";
const BACKGROUND_KEY = "HKCU\\Software\\Classes\\Directory\\Background\\shell\\MobiusDesktop";
const LABEL = "在 Mobius 桌面端打开";

function reg(args: string[]): boolean {
  try {
    return spawnSync("reg.exe", args, { windowsHide: true, encoding: "utf8", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export function ensureWindowsContextMenu(): void {
  if (process.platform !== "win32") return;
  const exe = process.execPath;
  const command = `"${exe.replace(/"/g, '""')}" --open-path "%1"`;
  for (const key of [MENU_KEY, BACKGROUND_KEY]) {
    // Respect an existing user-installed entry; only create missing commands.
    if (reg(["QUERY", `${key}\\command`])) continue;
    reg(["ADD", key, "/ve", "/d", LABEL, "/f"]);
    reg(["ADD", `${key}\\command`, "/ve", "/d", command, "/f"]);
  }
}

export function openPathArgument(argv: string[] = process.argv): string | null {
  const index = argv.findIndex((value) => value === "--open-path");
  const candidate = index >= 0 ? argv[index + 1] : null;
  return candidate && !candidate.startsWith("--") ? candidate : null;
}
