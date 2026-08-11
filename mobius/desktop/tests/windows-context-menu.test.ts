import assert from "node:assert/strict";
import { windowsContextMenuEntries } from "../electron/lib/windows-context-menu";

const exe = "C:\\Program Files\\Mobius Desktop\\Mobius Desktop.exe";
const [folder, background] = windowsContextMenuEntries(exe);

assert.equal(
  folder.command,
  `"${exe}" --open-path "%1"`,
  "folder context menu must pass Explorer's selected directory",
);
assert.equal(
  background.command,
  `"${exe}" --open-path "%V"`,
  "background context menu must pass Explorer's current directory",
);
assert.match(folder.key, /Directory\\shell\\MobiusDesktop$/);
assert.match(background.key, /Directory\\Background\\shell\\MobiusDesktop$/);

console.log("windows context menu tests passed");
