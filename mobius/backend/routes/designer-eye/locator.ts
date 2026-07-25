import fs from 'fs';
import path from 'path';
import { APP_DIR } from '../../config';

const ALLOWED_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.scss', '.html', '.vue']);
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'release', 'build', '.git', '.cache', 'coverage']);
const MAX_FILES = 4_000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SIGNALS = 18;
const MAX_CANDIDATES = 8;

type ScopeKind = 'core' | 'extension';

export type LocatorSignal = {
  kind: string;
  value: string;
  weight?: number;
};

export type LocatorRequest = {
  scope: ScopeKind;
  root: string;
  routePath?: string;
  signals: LocatorSignal[];
};

export type SourceCandidate = {
  file: string;
  line: number;
  score: number;
  matched: string[];
  preview: string;
};

const KIND_WEIGHT: Record<string, number> = {
  designId: 100,
  dataTour: 95,
  id: 88,
  ariaLabel: 85,
  title: 82,
  placeholder: 80,
  name: 72,
  text: 70,
  className: 55,
  ancestorDataTour: 48,
  ancestorAriaLabel: 42,
};

function normalizedSignals(input: unknown): LocatorSignal[] {
  if (!Array.isArray(input)) return [];
  const out: LocatorSignal[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, MAX_SIGNALS)) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = String((raw as any).kind || '').slice(0, 40);
    const value = String((raw as any).value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!kind || value.length < 2) continue;
    const key = `${kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, value, weight: KIND_WEIGHT[kind] || 30 });
  }
  return out;
}

type WeightedNeedle = { needle: string; factor: number };

function signalNeedles(signal: LocatorSignal): WeightedNeedle[] {
  const value = signal.value;
  // 属性完整写法是强证据；只在普通文字中出现同一值仍可作为兜底，但必须显著降权，
  // 否则 aria-label="搜索…" 会被另一组件中的说明文案误判为最高候选。
  const quoted = (name: string): WeightedNeedle[] => [
    { needle: `${name}="${value}"`, factor: 1 },
    { needle: `${name}='${value}'`, factor: 1 },
    { needle: value, factor: 0.35 },
  ];
  if (signal.kind === 'designId') return quoted('data-design-id');
  if (signal.kind === 'dataTour' || signal.kind === 'ancestorDataTour') return quoted('data-tour');
  if (signal.kind === 'ariaLabel' || signal.kind === 'ancestorAriaLabel') return quoted('aria-label');
  if (signal.kind === 'placeholder') return quoted('placeholder');
  if (signal.kind === 'title') return quoted('title');
  if (signal.kind === 'name') return quoted('name');
  if (signal.kind === 'id') return quoted('id');
  return [{ needle: value, factor: 1 }];
}

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  let totalBytes = 0;
  while (stack.length && files.length < MAX_FILES && totalBytes < MAX_TOTAL_BYTES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const size = fs.statSync(abs).size;
        if (size > MAX_FILE_BYTES) continue;
        totalBytes += size;
        files.push(abs);
      } catch { /* file disappeared during scan */ }
    }
  }
  return files;
}

function routeBonus(relativeFile: string, routePath: string): number {
  if (!routePath) return 0;
  if (/\/p\/[^/]+\/i\//.test(routePath) && /(IssuePage|components\/chat)\.(tsx|jsx)$/.test(relativeFile)) return 14;
  if (/\/p\/[^/]+\/r\//.test(routePath) && /ResearchPage\.(tsx|jsx)$/.test(relativeFile)) return 14;
  if (/\/mobius_overview_cluster/.test(routePath) && /MobiusOverviewClusterPage\.(tsx|jsx)$/.test(relativeFile)) return 14;
  if (/\/mobius_overview/.test(routePath) && /MobiusOverviewPage\.(tsx|jsx)$/.test(relativeFile)) return 14;
  if (/\/p\/[^/?]+/.test(routePath) && /ProjectPage\.(tsx|jsx)$/.test(relativeFile)) return 12;
  if (/\/welcome/.test(routePath) && /Welcome\.(tsx|jsx)$/.test(relativeFile)) return 12;
  if (/\/u\/[^/?]+/.test(routePath) && /UserPage\.(tsx|jsx)$/.test(relativeFile)) return 10;
  return 0;
}

function matchedLabel(signal: LocatorSignal): string {
  const labels: Record<string, string> = {
    designId: 'data-design-id',
    dataTour: 'data-tour',
    ariaLabel: 'aria-label',
    ancestorDataTour: 'ancestor data-tour',
    ancestorAriaLabel: 'ancestor aria-label',
    className: 'class',
  };
  return `${labels[signal.kind] || signal.kind}=${signal.value}`;
}

export function locateSourceCandidates(request: LocatorRequest): { scope: string; candidates: SourceCandidate[] } {
  const root = path.resolve(request.root);
  const appRoot = path.resolve(APP_DIR);
  if (root !== appRoot && !root.startsWith(appRoot + path.sep)) {
    throw new Error('源码搜索目录超出 APP_DIR');
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('源码搜索目录不存在');
  }

  const signals = normalizedSignals(request.signals);
  if (!signals.length) return { scope: path.relative(appRoot, root), candidates: [] };

  const candidates: SourceCandidate[] = [];
  for (const abs of listSourceFiles(root)) {
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); }
    catch { continue; }
    const lines = content.split(/\r?\n/);
    const relativeFile = path.relative(appRoot, abs).replace(/\\/g, '/');
    const bonus = routeBonus(relativeFile, request.routePath || '');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched: string[] = [];
      let score = 0;
      for (const signal of signals) {
        const factor = signalNeedles(signal)
          .filter(item => line.includes(item.needle))
          .reduce((best, item) => Math.max(best, item.factor), 0);
        if (!factor) continue;
        matched.push(matchedLabel(signal));
        score += Math.round((signal.weight || 30) * factor);
      }
      if (!matched.length) continue;
      candidates.push({
        file: relativeFile,
        line: index + 1,
        score: score + bonus,
        matched,
        preview: line.replace(/\s+/g, ' ').trim().slice(0, 260),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return {
    scope: path.relative(appRoot, root).replace(/\\/g, '/'),
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}
