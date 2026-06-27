import { v4 as uuid } from 'uuid';
import { Sessions } from '../repositories/sessions';
import { Issues, IssueIntegrations } from '../repositories/issues';
import { Changes, Conflicts, Queue } from '../repositories/changes';
import { Messages } from '../repositories/messages';
import { audit } from '../repositories/audit';
import {
  currentBaseRevision,
  normalizeChangedFile,
  fileRisk,
  conflictId,
  conflictKind,
} from '../utils/helpers';

function extractChangedFiles(sessionId: any, manualFiles: any[] = []): any[] {
  const files = new Map();
  const add = (raw: any, meta: any = {}) => {
    const filePath = normalizeChangedFile(typeof raw === 'string' ? raw : raw?.file_path || raw?.path);
    if (!filePath) return;
    files.set(filePath, {
      file_path: filePath,
      change_type: meta.change_type || raw?.change_type || 'modified',
      additions: Number(meta.additions ?? raw?.additions ?? 0) || 0,
      deletions: Number(meta.deletions ?? raw?.deletions ?? 0) || 0,
      symbols: JSON.stringify(meta.symbols ?? raw?.symbols ?? []),
      risk_level: meta.risk_level || raw?.risk_level || fileRisk(filePath),
    });
  };

  for (const f of manualFiles || []) add(f);

  const messages = Messages.recentContentForSession(sessionId, 80);
  const pathPattern = /(?:\/home\/user\/imac-test\/|imac-test\/|\.\/)?(?:mobius|hooks|dashboard|standup)\/[A-Za-z0-9_./@+:-]+\.(?:js|jsx|ts|tsx|css|json|md|toml|sh|sql|go|html)/g;
  for (const m of messages) {
    const content = m.content || '';
    const matches = content.match(pathPattern) || [];
    for (const match of matches) add(match);
  }
  return Array.from(files.values()).slice(0, 80);
}

function summarizeSessionChange(session: any, files: any[]): string {
  const latest = Messages.latestAssistantOrTool(session.session_id);
  const base = latest?.content ? latest.content.replace(/\s+/g, ' ').slice(0, 180) : '';
  if (base) return base;
  if (files.length) return `会话「${session.name}」涉及 ${files.length} 个文件: ${files.slice(0, 4).map(f => f.file_path).join('、')}`;
  return `会话「${session.name}」尚未扫描到明确文件变更, 可手动补充 touched files。`;
}

function recomputeProjectConflicts(projectId: any): void {
  const changes = Changes.activeForProject(projectId);
  const filesByChange = new Map();
  for (const change of changes) {
    filesByChange.set(change.id, Changes.filesByChange(change.id));
  }

  const activeIds = new Set(changes.map(c => c.id));
  Conflicts.resolveStaleByChangeIds(changes.map(c => c.id), activeIds);

  for (let i = 0; i < changes.length; i++) {
    for (let j = i + 1; j < changes.length; j++) {
      const left = changes[i], right = changes[j];
      const leftFiles = filesByChange.get(left.id) || [];
      const rightPaths = new Map((filesByChange.get(right.id) || []).map(f => [f.file_path, f]));
      for (const lf of leftFiles) {
        const rf = rightPaths.get(lf.file_path);
        if (!rf) continue;
        const risk = ['schema', 'config', 'high'].includes(lf.risk_level) ? lf.risk_level : rf.risk_level;
        const kind = conflictKind(lf.file_path, risk);
        const scope = left.issue_id === right.issue_id ? '内部冲突' : '外部冲突';
        Conflicts.insertIfAbsent.run(
          conflictId(left.id, right.id, lf.file_path),
          left.id,
          right.id,
          lf.file_path,
          kind.type,
          kind.severity,
          `${scope}: ${left.session_name} 与 ${right.session_name} 同时修改 ${lf.file_path}`
        );
      }
    }
  }

  for (const issue of Issues.listIdsForProject(projectId)) {
    refreshIssueIntegration(issue.id);
  }
}

function refreshIssueIntegration(issueId: any): any {
  const issue = Issues.findById(issueId);
  if (!issue) return null;
  const existing = IssueIntegrations.findByIssue(issueId);
  const integrationId = existing?.id || uuid().slice(0, 12);

  const counts = IssueIntegrations.conflictCounts(issueId);
  const changeStats = IssueIntegrations.changeStats(issueId);

  const internal = Number(counts?.internal_count || 0);
  const external = Number(counts?.external_count || 0);
  const blocking = Number(counts?.blocking_count || 0);
  let status = existing?.status || 'collecting';
  let buildStatus = existing?.build_status || 'pending';
  if (blocking > 0 || changeStats?.failed_count > 0) status = 'blocked';
  else if (changeStats?.total > 0 && changeStats.ready_count === changeStats.total) status = existing?.acceptance_status === 'passed' ? 'ready' : 'checking';
  if (changeStats?.total > 0 && changeStats?.failed_count === 0) buildStatus = 'passed';

  IssueIntegrations.upsert({
    id: integrationId,
    issueId: issue.id,
    projectId: issue.project_id,
    status,
    internal,
    external,
    buildStatus,
  });

  return IssueIntegrations.findByIssue(issueId);
}

function changePayload(changeId: any): any {
  const change = Changes.payloadById(changeId);
  if (!change) return null;
  return {
    ...change,
    files: Changes.filesByChange(changeId),
    conflicts: Changes.conflictsByChange(changeId),
  };
}

function scanSessionChange(req: any, session: any, manualFiles: any[] = []): any {
  const files = extractChangedFiles(session.session_id, manualFiles);
  const existing = Changes.findBySession(session.session_id);
  const changeId = existing?.id || uuid().slice(0, 12);
  const summary = summarizeSessionChange(session, files);

  Changes.upsert({
    id: changeId,
    session_id: session.session_id,
    issue_id: session.issue_id,
    project_id: session.project_id,
    base_revision: existing?.base_revision || currentBaseRevision(),
    summary,
  });

  Changes.deleteFiles(changeId);
  for (const f of files) {
    Changes.insertFile.run(changeId, f.file_path, f.change_type, f.additions, f.deletions, f.symbols, f.risk_level);
  }

  recomputeProjectConflicts(session.project_id);
  const openBlocking = Changes.countOpenBlockingForChange(changeId);
  Changes.setStatus(changeId, openBlocking > 0 ? 'conflict' : 'ready');
  refreshIssueIntegration(session.issue_id);
  audit(req.user.id, 'scan_session_change', 'session', session.session_id, `${files.length} files`);
  return changePayload(changeId);
}

function integrateIssue(req: any, issueId: any): any {
  const issue = Issues.findById(issueId);
  if (!issue) return { ok: false, error: 'Issue 不存在' };
  const integration = refreshIssueIntegration(issue.id);
  if (!integration || integration.status !== 'ready' || integration.acceptance_status !== 'passed') {
    return { ok: false, error: 'Issue 尚未达到可合入状态' };
  }
  const blocking = Conflicts.countOpenBlockingForIssue(issue.id);
  if (blocking > 0) return { ok: false, error: '仍存在阻塞冲突' };

  Queue.setIntegratingFor(issue.project_id, issue.id);
  Changes.markIssueIntegrated(issue.id);
  IssueIntegrations.markIntegrated(issue.id);
  Queue.markIntegrated(issue.project_id, issue.id);
  audit(req.user.id, 'integrate_issue', 'issue', issue.id, 'integrated to test-main');
  recomputeProjectConflicts(issue.project_id);
  return { ok: true };
}

export {
  scanSessionChange,
  recomputeProjectConflicts,
  refreshIssueIntegration,
  changePayload,
  integrateIssue,
};
