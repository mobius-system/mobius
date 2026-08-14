import assert from "node:assert/strict";
import path from "node:path";
import { findExactProjectPath, findExactProjectRoot } from "../electron/lib/project-path-matching";

const userRoot = "C:\\Users\\example";
const assistantId = "assistant-project";
const shared = {
  [userRoot]: assistantId,
  [`${userRoot}\\Desktop\\MobiusOS\\pawbench`]: "pawbench-project",
};

assert.equal(
  findExactProjectPath(`${userRoot}\\Downloads\\other`, shared, path.win32),
  null,
  "a TUI cwd mapping must not capture unrelated descendants",
);
assert.deepEqual(
  findExactProjectPath(userRoot, shared, path.win32),
  { projectId: assistantId, root: userRoot },
  "an exact TUI cwd remains valid",
);

const local = [
  { projectId: assistantId, root: userRoot },
  { projectId: "pawbench-project", root: `${userRoot}\\Desktop\\MobiusOS\\pawbench` },
];
assert.equal(
  findExactProjectRoot(`${userRoot}\\Desktop\\MobiusOS\\pawbench\\src`, local, path.win32),
  null,
  "an Electron project binding must not capture a child directory",
);
assert.deepEqual(
  findExactProjectRoot(`${userRoot}\\Desktop\\MobiusOS\\pawbench`, local, path.win32),
  { projectId: "pawbench-project", root: `${userRoot}\\Desktop\\MobiusOS\\pawbench` },
  "an exact Electron project binding remains valid",
);
assert.equal(
  findExactProjectRoot(`${userRoot}\\Downloads\\other`, local, path.win32),
  null,
  "an Electron binding must not capture unrelated paths",
);

console.log("project path matching tests passed");
