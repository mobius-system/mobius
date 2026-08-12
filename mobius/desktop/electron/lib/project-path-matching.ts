import type * as path from "node:path";

export interface ProjectPathMatch {
  projectId: string;
  root: string;
}

type PathApi = Pick<typeof path.win32, "isAbsolute" | "relative" | "resolve">;

function isSameOrChild(pathApi: PathApi, root: string, target: string): boolean {
  const rel = pathApi.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
}

/** TUI's dir2project.json is a cwd -> project map, so only exact cwd matches. */
export function findExactProjectPath(
  rawPath: string,
  mappings: Record<string, string>,
  pathApi: PathApi,
): ProjectPathMatch | null {
  const target = pathApi.resolve(rawPath);
  for (const [rawRoot, rawId] of Object.entries(mappings)) {
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    const root = pathApi.resolve(rawRoot);
    if (pathApi.relative(root, target) === "") return { projectId: rawId.trim(), root };
  }
  return null;
}

/** Electron-owned project roots may route their descendants to the same project. */
export function findNearestProjectRoot(
  rawPath: string,
  mappings: ProjectPathMatch[],
  pathApi: PathApi,
  ignoredRoots: string[] = [],
): ProjectPathMatch | null {
  const target = pathApi.resolve(rawPath);
  const ignored = ignoredRoots.map((value) => pathApi.resolve(value));
  let best: ProjectPathMatch | null = null;

  for (const mapping of mappings) {
    if (!mapping.projectId.trim() || !mapping.root.trim()) continue;
    const root = pathApi.resolve(mapping.root);
    if (ignored.some((value) => pathApi.relative(value, root) === "")) continue;
    if (!isSameOrChild(pathApi, root, target)) continue;
    if (!best || root.length > best.root.length) best = { projectId: mapping.projectId.trim(), root };
  }
  return best;
}
