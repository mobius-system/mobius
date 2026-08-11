import { spawnSync } from "node:child_process";

const MENU_KEY = "HKCU\\Software\\Classes\\Directory\\shell\\MobiusDesktop";
const BACKGROUND_KEY = "HKCU\\Software\\Classes\\Directory\\Background\\shell\\MobiusDesktop";
const LABEL = "在 Mobius 桌面端打开";

export interface WindowsContextMenuEntry {
  key: string;
  command: string;
}

function reg(args: string[]): boolean {
  try {
    return spawnSync("reg.exe", args, { windowsHide: true, encoding: "utf8", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export function ensureWindowsContextMenu(): void {
  if (process.platform !== "win32") return;
  for (const { key, command } of windowsContextMenuEntries(process.execPath)) {
    // These keys are owned by Mobius Desktop. Rewriting them on every launch
    // repairs stale executable paths left behind by zip upgrades or moves.
    reg(["ADD", key, "/ve", "/d", LABEL, "/f"]);
    reg(["ADD", key, "/v", "MUIVerb", "/d", LABEL, "/f"]);
    reg(["ADD", key, "/v", "Icon", "/d", process.execPath, "/f"]);
    // Stale shell-extension values take precedence over the command subkey and
    // produce Explorer's "no associated app" dialog even when the default
    // command is valid. Ignore delete failures when the values are absent.
    reg(["DELETE", key, "/v", "ExplorerCommandHandler", "/f"]);
    reg(["DELETE", `${key}\\command`, "/v", "DelegateExecute", "/f"]);
    reg(["ADD", `${key}\\command`, "/ve", "/d", command, "/f"]);
  }
}

export function windowsContextMenuEntries(executable: string): WindowsContextMenuEntry[] {
  const quotedExe = `"${executable.replace(/"/g, '""')}"`;
  return [
    { key: MENU_KEY, command: `${quotedExe} --open-path "%1"` },
    // Explorer supplies the current directory as %V for a background click;
    // %1 is not defined in that context and can trigger a file-association error.
    { key: BACKGROUND_KEY, command: `${quotedExe} --open-path "%V"` },
  ];
}

export function openPathArgument(argv: string[] = process.argv): string | null {
  const index = argv.findIndex((value) => value === "--open-path");
  const candidate = index >= 0 ? argv[index + 1] : null;
  return candidate && !candidate.startsWith("--") ? candidate : null;
}
