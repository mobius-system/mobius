import type * as path from "node:path";

export interface ProjectPathMatch {
  projectId: string;
  root: string;
}

type PathApi = Pick<typeof path.win32, "relative" | "resolve">;

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

/** Electron-owned bindings follow the same exact-path rule as TUI bindings. */
export function findExactProjectRoot(
  rawPath: string,
  mappings: ProjectPathMatch[],
  pathApi: PathApi,
): ProjectPathMatch | null {
  const target = pathApi.resolve(rawPath);
  for (const mapping of mappings) {
    if (!mapping.projectId.trim() || !mapping.root.trim()) continue;
    const root = pathApi.resolve(mapping.root);
    if (pathApi.relative(root, target) === "") return { projectId: mapping.projectId.trim(), root };
  }
  return null;
}
